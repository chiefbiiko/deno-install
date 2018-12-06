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
  mkdir,
  platform,
  symlink,
  writeFile,
  removeAll,
  run,
  makeTempDir
} from 'deno'

import mkdirp from 'https://raw.githubusercontent.com/chiefbiiko/deno-mkdirp/master/mkdirp.ts'

const HELP: string = 'help yoself'

const WIN32: boolean = platform.os === 'win'
const PATH_SEPARATOR: string = WIN32 ? '\\' : '/'

const path_join: Function = (...parts: string[]) : string => {
  return parts.join(PATH_SEPARATOR)
}

const proc_env: { [key:string]: any } = env()

const get_home: Function = function () : string {
  return WIN32 ? proc_env.HOMEPATH : proc_env.HOME
}

const DENO_REPO_URL: string = 'https://github.com/denoland/deno'
const LATEST_RELEASE_URL: string = `${DENO_REPO_URL}/releases/latest`
const TAG_RELEASE_URL: string = `${DENO_REPO_URL}/releases/tag`

const DENO_DIR: string = path_join(get_home(), '.deno')
const DENO_BIN_DIR: string = path_join(DENO_DIR, 'bin')
const DENO_BIN: string = path_join(DENO_BIN_DIR, WIN32 ? 'deno.exe' : 'deno')
const DENO_LINK: string = path_join(
  WIN32 ? '' : '/usr/local/bin', WIN32 ? 'deno.exe' : 'deno'
)

const LINUX_GZIP: string = 'deno_linux_x64.gz'
const OSX_GZIP: string = 'deno_osx_x64.gz'
const WIN_ZIP: string = 'deno_win_x64.zip'

const panic: Function = (err: Error) : void => {
  if (err) console.error('[deno-update error]', err.stack)
  exit(1)
}

const pinup: Function = (...args: any) : void => {
  console.log('[deno-update info]', ...args)
}

const follow: Function = async (url: string) : Promise<any> => {
  var located: boolean = false
  var res: any // TODO: annotate deno Response
  while (!located) {
    res = await fetch(url)
    if (String(res.status).startsWith('3')) url = res.headers.get('Location')
    if (res.status === 200) located = true
  }
  return res
}

const release_url: Function = 
  async (tag?: string) : Promise<{ [key: string]: string }> => {
  const url: string = tag ? `${TAG_RELEASE_URL}/${tag}` : LATEST_RELEASE_URL
  var filename: string
  switch (platform.os) {
    case 'linux': filename = LINUX_GZIP; break
    case 'mac': filename = OSX_GZIP; break
    case 'win': filename = WIN_ZIP; break
    default: throw Error(`unsupported OS ${platform.os}`)
  }
  const res: any = await follow(url) // TODO: annotate deno Response
  const link: string = (await res.text())
    .split(/\r?\n/)
    .find((line: string) => line.includes('href') && line.includes(filename))
  if (!link) panic(Error(`can't find ${filename} @ ${url}`))
  const match: string = link.replace(/^.*href=(?:"|')([^"']*)(?:"|').*$/, '$1')
  if (!/^\/denoland/.test(match)) panic(Error(`can't find ${filename} @ ${url}`))
  return {
    url: `https://github.com${match}`,
    tag: match.replace(/^.*(v\d+\.\d+\.\d+).*$/, '$1')
  }
}

const temp_download: Function = 
  async (temp_dir: string, url: string, suffix: string) : Promise<string> => {
  const res: any = await follow(url) // TODO: annotate deno Response
  const arr_buf: ArrayBuffer = await res.arrayBuffer()
  const temp_file: string = `${temp_dir}/${Date.now()}.${suffix}`
  await writeFile(temp_file, new Uint8Array(arr_buf))
  return temp_file
}

const unpack_deno_bin: Function = async (archive: string) : Promise<void> => {
  await mkdirp(DENO_BIN_DIR)
  let args: string[]
  if (WIN32) args = [ 'unzip.bat', archive, DENO_BIN_DIR ]
  else args = [ 'gunzip', '-d', archive ]
  const child: Process = run({ args })
  const child_status: ProcessStatus = await child.status()
  if (!child_status.success)
    panic(Error(`(g)unzip failed with code ${child_status.code}`))
  if (!WIN32) {
    const gunzipd: string = archive.replace(/\.gz$/, '')
    await copyFile(gunzipd, DENO_BIN)
  }
  child.close()
}

const mk_handy: Function = async () : Promise<void> => {
  await chmod(DENO_DIR, 0o744)
  await chmod(DENO_BIN, 0o744)
  try {
    await lstat(DENO_LINK)
  } catch (err) {
    if (err.kind !== ErrorKind.NotFound) panic(err)
    await symlink(DENO_BIN, DENO_LINK, WIN32 ? 'file' : undefined)
  }
}

const ck_deno: Function = async (tag: string) : Promise<void> => {
  const deno_proc: Process = run({
    args: [ 'deno', '--version' ],
    stdout: 'piped'
  })
  const deno_status: ProcessStatus = await deno_proc.status()
  if (!deno_status.success) panic(Error('update failed'))
  const deno_stdout: Uint8Array = new Uint8Array(32)
  while ((await deno_proc.stdout.read(deno_stdout)).nread < 16);
  deno_proc.close()
  const output: string = new TextDecoder('utf-8').decode(deno_stdout)
  if (!RegExp(tag.replace(/^v/, '').replace(/\./g, '\\.')).test(output))
    panic(Error('version mismatch'))
}

const main: Function = async () : Promise<void> => {
  if (args.some((arg: string) => /^(?:-h|--help)$/.test(arg)))
    return console.log(HELP)
  var tag: string
  if (/^v\d+\.\d+\.\d+$/.test(args[1])) tag = args[1]
  pinup(tag ? `updating 2 deno ${tag}` : 'updating 2 deno@latest')
  const actual: { [key: string]: string } = await release_url(tag)
  const temp_dir: string = await makeTempDir()
  pinup(`downloading ${actual.url}`)
  const temp_file: string = 
    await temp_download(temp_dir, actual.url, WIN32 ? 'zip' : 'gz')
  await unpack_deno_bin(temp_file)
  pinup('plugging up da binary')
  await mk_handy()
  await ck_deno(actual.tag)
  await removeAll(temp_dir)
  pinup(`update ok`)
}

main()
