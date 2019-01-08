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
  removeAll,
  rename,
  run,
  makeTempDir
} from "deno";

import { mkdirp } from "https://deno.land/x/std/mkdirp/mkdirp.ts";
import { join, win32 } from "https://deno.land/x/path/index.ts";

const WIN32: boolean = platform.os === "win";

const proc_env: { [key: string]: any } = env();

function get_home(): string {
  return WIN32
    ? win32.resolve(proc_env.HOMEDRIVE, proc_env.HOMEPATH)
    : proc_env.HOME;
}

const DENO_REPO_URL: string = "https://github.com/denoland/deno";
const LATEST_RELEASE_URL: string = `${DENO_REPO_URL}/releases/latest`;
const TAG_RELEASE_URL: string = `${DENO_REPO_URL}/releases/tag`;

const DENO_DIR: string = join(get_home(), ".deno");
const DENO_BIN_DIR: string = join(DENO_DIR, "bin");
const DENO_BIN: string = join(DENO_BIN_DIR, WIN32 ? "deno.exe" : "deno");
const OLD_DENO_BIN: string = DENO_BIN.replace(/deno(\.exe)?$/, "old_deno$1");
const DENO_LINK: string = join(
  WIN32 ? win32.resolve(proc_env.SystemRoot, "System32") : "/usr/local/bin",
  WIN32 ? "deno.exe" : "deno"
);

const LINUX_GZIP: string = "deno_linux_x64.gz";
const OSX_GZIP: string = "deno_osx_x64.gz";
const WIN_ZIP: string = "deno_win_x64.zip";

function panic(err: Error): void {
  if (err) console.error("[deno-install error]", err.stack);
  console.error("[deno-install error]", "installation failed");
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
    if (++count === 4) throw Error(`unable to fetch from ${url}`);
    res = await fetch(url);
    if (res.status >= 300 && res.status < 400)
      url = res.headers.get("Location");
    else if (res.status === 200) located = true;
  }
  return res;
}

async function release_url(tag?: string): Promise<{ [key: string]: string }> {
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
      throw Error(`unsupported OS ${platform.os}`);
  }
  const res: any = await follow(url); // TODO: annotate deno Response
  const link: string = (await res.text())
    .split(/\r?\n/)
    .find((line: string) => line.includes("href") && line.includes(filename));
  if (!link) panic(Error(`unable to find ${filename} @ ${url}`));
  const match: string = link.replace(/^.*href=(?:"|')([^"']*)(?:"|').*$/, "$1");
  if (!/^\/denoland/.test(match))
    panic(Error(`unable to find ${filename} @ ${url}`));
  return {
    url: `https://github.com${match}`,
    tag: match.replace(/^.*(v\d+\.\d+\.\d+).*$/, "$1")
  };
}

async function temp_download(
  temp_dir: string,
  url: string,
  suffix: string
): Promise<string> {
  const res: any = await follow(url); // TODO: annotate deno Response
  const temp_file: string = join(temp_dir, `${Date.now()}.${suffix}`);
  await writeFile(temp_file, new Uint8Array(await res.arrayBuffer()));
  return temp_file;
}

async function unpack_bin(archive: string): Promise<void> {
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
  const child_status: ProcessStatus = await child.status();
  if (!child_status.success)
    panic(Error(`(g)unzip failed. ${args} -> ${child_status.code}`));
  child.close();
  if (!WIN32) {
    if (platform.os === "linux") await rename(DENO_BIN, OLD_DENO_BIN);
    await copyFile(archive.replace(/\.gz$/, ""), DENO_BIN);
  }
}

async function make_handy(): Promise<void> {
  if (WIN32) {
    if (!proc_env.Path.includes(DENO_BIN_DIR)) {
      console.log("bouta edit the PATH environment variable");
      const upd_path: string = `${proc_env.Path};${DENO_BIN_DIR}`;
      let args: string[] = [
        "powershell.exe",
        "-Command",
        `[Environment]::SetEnvironmentVariable("PATH","${upd_path}",` +
          `[EnvironmentVariableTarget]::User)`
      ];
      let ps: Process = run({ args });
      let ps_status: ProcessStatus = await ps.status();
      if (!ps_status.success)
        panic(Error(`unable to edit PATH. ${args} -> ${ps_status.code}`));
      ps.close();
      args = ["powershell.exe", "-Command", `$env:PATH = "${upd_path}"`];
      ps = run({ args });
      ps_status = await ps.status();
      if (!ps_status.success)
        panic(Error(`unable to edit PATH. ${args} -> ${ps_status.code}`));
      ps.close();
    }
  } else {
    await chmod(DENO_DIR, 0o744);
    await chmod(DENO_BIN, 0o744);
    try {
      await lstat(DENO_LINK);
    } catch (err) {
      if (err.kind !== ErrorKind.NotFound) panic(err);
      await symlink(DENO_BIN, DENO_LINK);
    }
  }
}

async function check_version(tag: string): Promise<void> {
  const deno_proc: Process = run({
    args: ["deno", "--version"],
    stdout: "piped"
  });
  const deno_status: ProcessStatus = await deno_proc.status();
  if (!deno_status.success) panic(Error("deno test run failed"));
  const deno_stdout: Uint8Array = new Uint8Array(32);
  while ((await deno_proc.stdout.read(deno_stdout)).nread < 16);
  deno_proc.close();
  const output: string = new TextDecoder().decode(deno_stdout);
  if (!RegExp(tag.replace(/^v/, "").replace(/\./g, "\\.")).test(output))
    panic(Error("version mismatch"));
}

async function main(): Promise<void> {
  let tag: string;
  if (/^v\d+\.\d+\.\d+$/.test(args[1])) tag = args[1];
  pinup(tag ? `installing deno ${tag}` : "installing deno@latest");
  const actual: { [key: string]: string } = await release_url(tag);
  const temp_dir: string = await makeTempDir();
  pinup(`downloading ${actual.url}`);
  const temp_file: string = await temp_download(
    temp_dir,
    actual.url,
    WIN32 ? "zip" : "gz"
  );
  await unpack_bin(temp_file);
  pinup("plugging up da binary");
  await make_handy();
  await check_version(actual.tag);
  await removeAll(temp_dir);
  pinup(`successfully installed deno ${actual.tag}`);
}

main();
