import {
  ErrorKind,
  Process,
  ProcessStatus,
  args,
  chmod,
  copyFile,
  env,
  exit,
  lstat,
  platform,
  symlink,
  writeFile,
  readFile,
  removeAll,
  rename,
  run,
  makeTempDir
} from "deno";

import { mkdirp } from "https://deno.land/x/std/mkdirp/mkdirp.ts";
import { join, win32 } from "https://deno.land/x/path/index.ts";

const WIN32: boolean = platform.os === "win";

const procEnv: { [key: string]: any } = env();

function getHome(): string {
  return WIN32
    ? win32.resolve(procEnv.HOMEDRIVE, procEnv.HOMEPATH)
    : procEnv.HOME;
}

const DENO_REPO_URL: string = "https://github.com/denoland/deno";
const LATEST_RELEASE_URL: string = `${DENO_REPO_URL}/releases/latest`;
const TAG_RELEASE_URL: string = `${DENO_REPO_URL}/releases/tag`;

const DENO_DIR: string = join(getHome(), ".deno");
const DENO_BIN_DIR: string = join(DENO_DIR, "bin");
const DENO_BIN: string = join(DENO_BIN_DIR, WIN32 ? "deno.exe" : "deno");
const OLD_DENO_BIN: string = DENO_BIN.replace(/deno(\.exe)?$/, "old_deno$1");
const DENO_LINK: string = "/usr/local/bin/deno";
const BASH_PROFILE: string = "~/.bash_profile"
const LINUX_GZIP: string = "deno_linux_x64.gz";
const OSX_GZIP: string = "deno_osx_x64.gz";
const WIN_ZIP: string = "deno_win_x64.zip";

function panic(err: Error): void {
  if (err) console.error("[deno-install error]", err.stack);
  console.error("[deno-install error]", "Installation failed");
  exit(1);
}

function pinup(...args: any): void {
  console.log("[deno-install info]", ...args);
}

async function follow(url: string): Promise<any> {
  let located: boolean = false;
  let res: any; // TODO: annotate deno Response
  let count: number = 0;
  while (!located) {
    if (++count === 4) throw Error(`Unable to fetch from ${url}`);
    res = await fetch(url);
    if (res.status >= 300 && res.status < 400)
      url = res.headers.get("Location");
    else if (res.status === 200) located = true;
  }
  return res;
}

async function releaseUrl(tag?: string): Promise<{ [key: string]: string }> {
  const url: string = tag ? `${TAG_RELEASE_URL}/${tag}` : LATEST_RELEASE_URL;
  let filename: string;
  switch (platform.os) {
    case "linux":
      filename = LINUX_GZIP;
      break;
    case "mac":
      filename = OSX_GZIP;
      break;
    case "win":
      filename = WIN_ZIP;
      break;
    default:
      throw Error(`Unsupported operating system ${platform.os}`);
  }
  const res: any = await follow(url); // TODO: annotate deno Response
  const link: string = (await res.text())
    .split(/\r?\n/)
    .find((line: string) => line.includes("href") && line.includes(filename));
  if (!link) panic(Error(`Unable to find ${filename} @ ${url}`));
  const match: string = link.replace(/^.*href=(?:"|')([^"']*)(?:"|').*$/, "$1");
  if (!/^\/denoland/.test(match))
    panic(Error(`Unable to find ${filename} @ ${url}`));
  return {
    url: `https://github.com${match}`,
    tag: match.replace(/^.*(v\d+\.\d+\.\d+).*$/, "$1")
  };
}

async function tempDownload(
  tempDir: string,
  url: string,
  suffix: string
): Promise<string> {
  const res: any = await follow(url); // TODO: annotate deno Response
  const tempFile: string = join(tempDir, `${Date.now()}.${suffix}`);
  await writeFile(tempFile, new Uint8Array(await res.arrayBuffer()));
  return tempFile;
}

async function unpackBin(archive: string): Promise<void> {
  await mkdirp(DENO_BIN_DIR);
  let args: string[];
  if (WIN32) {
    await rename(DENO_BIN, OLD_DENO_BIN);
    args = [
      "powershell.exe",
      "-Command",
      `Expand-Archive "${archive}" -DestinationPath "${DENO_BIN_DIR}"`
    ];
  } else {
    args = ["gunzip", "-d", archive];
  }
  const child: Process = run({ args });
  const childStatus: ProcessStatus = await child.status();
  if (!childStatus.success)
    panic(Error(`(g)unzip failed. ${args} -> ${childStatus.code}`));
  child.close();
  if (!WIN32) {
    if (platform.os === "linux") await rename(DENO_BIN, OLD_DENO_BIN);
    await copyFile(archive.replace(/\.gz$/, ""), DENO_BIN);
  }
}

async function makeHandy(): Promise<void> {
  const updatedPath: string = `${procEnv.Path};${DENO_BIN_DIR}`;
  if (WIN32) {
    if (!procEnv.Path.toLocaleLowerCase().includes(DENO_BIN_DIR)) {
      // const updatedPath: string = `${procEnv.Path};${DENO_BIN_DIR}`;
      const args: string[] = [
        "powershell.exe",
        "-Command",
        `[Environment]::SetEnvironmentVariable("PATH","${updatedPath}",` +
          `[EnvironmentVariableTarget]::User)`
      ];
      const ps: Process = run({ args });
      const psStatus: ProcessStatus = await ps.status();
      if (!psStatus.success)
        panic(Error(`Unable to edit PATH. ${args} -> ${psStatus.code}`));
      ps.close();
      // pinup(
      //   `Just added ${DENO_BIN_DIR} to your PATH. Start a fresh shell ` +
      //     `session to have "deno" available on the command line.`
      // );
    }
  } else {
    await chmod(DENO_DIR, 0o744);
    await chmod(DENO_BIN, 0o744);
    // if (!procEnv.Path.toLocaleLowerCase().includes(DENO_BIN_DIR)) {
    //   // const updatedPath: string = `${procEnv.Path};${DENO_BIN_DIR}`;
    //   // const args: string[] = [
    //   //   "powershell.exe",
    //   //   "-Command",
    //   //   `[Environment]::SetEnvironmentVariable("PATH","${updatedPath}",` +
    //   //     `[EnvironmentVariableTarget]::User)`
    //   // ];
    //   let bashProfile: string = new TextDecoder().decode(await readFile(BASH_PROFILE))
    //   if (!/PATH=[^\n]+.deno\/bin/.test(bashProfile)) {
    //     bashProfile = `${bashProfile}\nPATH=$PATH:${DENO_BIN_DIR}\n`
    //     if (!/export PATH/.test(bashProfile)) bashProfile += "\nexport PATH\n"
    //     await writeFile(BASH_PROFILE, new TextEncoder().encode(bashProfile))
    //   }
    //   // const ps: Process = run({ args });
    //   // const psStatus: ProcessStatus = await ps.status();
    //   // if (!psStatus.success)
    //   //   panic(Error(`Unable to edit PATH. ${args} -> ${psStatus.code}`));
    //   // ps.close();
    // }
  }
}

async function checkVersion(tag: string): Promise<void> {
  const denoProc: Process = run({
    args: ["deno", "--version"],
    stdout: "piped"
  });
  const denoStatus: ProcessStatus = await denoProc.status();
  if (!denoStatus.success) panic(Error("Test run failed"));
  const denoStdout: Uint8Array = new Uint8Array(32);
  while ((await denoProc.stdout.read(denoStdout)).nread < 16);
  denoProc.close();
  const output: string = new TextDecoder().decode(denoStdout);
  if (!RegExp(tag.replace(/^v/, "").replace(/\./g, "\\.")).test(output))
    panic(Error("Version mismatch"));
}

async function main(): Promise<void> {
  let tag: string;
  if (/^v\d+\.\d+\.\d+$/.test(args[1])) tag = args[1];
  pinup(tag ? `Installing deno ${tag}` : "Installing deno@latest");
  const actual: { [key: string]: string } = await releaseUrl(tag);
  const tempDir: string = await makeTempDir();
  pinup(`Downloading ${actual.url}`);
  const tempFile: string = await tempDownload(
    tempDir,
    actual.url,
    WIN32 ? "zip" : "gz"
  );
  await unpackBin(tempFile);
  await makeHandy();
  await checkVersion(actual.tag);
  await removeAll(tempDir);
  pinup(`Successfully installed deno ${actual.tag}`);
}

main();
