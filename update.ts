import {
  ErrorKind,
  Process,
  ProcessStatus,
  args,
  chmod,
  copyFile,
  cwd,
  env,
  exit,
  lstat,
  platform,
  symlink,
  writeFile,
  removeAll,
  run,
  makeTempDir
} from 'deno'

import mkdirp from 'https://raw.githubusercontent.com/chiefbiiko/deno-mkdirp/master/mkdirp.ts'
import * as path from "https://deno.land/x/path/index.ts"

const WIN32: boolean = platform.os === 'win'

const prep_wunzip: Function = async (temp_dir: string, zip_file: string, dest_dir: string) : Promise<string[]> => {
  const script_file: string = path.join(temp_dir, 'wunzip.vbs')
  const encoder: TextEncoder = new TextEncoder('utf-8')
  const script_data: Uint8Array = encoder.encode(`
    set objShell = CreateObject("Shell.Application")
    set FilesInZip=objShell.NameSpace("${zip_file}").items
    objShell.NameSpace("${dest_dir}").CopyHere(FilesInZip)
    Set objShell = Nothing
  `.replace(/^ +/gm, '').trim())
  await writeFile(script_file, script_data)
  return [ 'cscript', '//nologo', script_file ]
}

const proc_env: { [key:string]: any } = env()

const get_home: Function = () : string => {
  return WIN32 ? path.win32.resolve('C:', proc_env.HOMEPATH) : proc_env.HOME
}

const DENO_REPO_URL: string = 'https://github.com/denoland/deno'
const LATEST_RELEASE_URL: string = `${DENO_REPO_URL}/releases/latest`
const TAG_RELEASE_URL: string = `${DENO_REPO_URL}/releases/tag`

const DENO_DIR: string = path.join(get_home(), '.deno')
const DENO_BIN_DIR: string = path.join(DENO_DIR, 'bin')
const DENO_BIN: string = path.join(DENO_BIN_DIR, WIN32 ? 'deno.exe' : 'deno')
const DENO_LINK: string = path.join(
  WIN32 ? path.win32.resolve('C:', 'Windows', 'System32') : '/usr/local/bin', WIN32 ? 'deno.exe' : 'deno'
)

const LINUX_GZIP: string = 'deno_linux_x64.gz'
const OSX_GZIP: string = 'deno_osx_x64.gz'
const WIN_ZIP: string = 'deno_win_x64.zip'

const panic: Function = (err: Error) : void => {
  if (err) console.error('[deno-update error]', err.stack)
  console.error('[deno-update error]', 'update failed')
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
  const temp_file: string = path.join(temp_dir, `${Date.now()}.${suffix}`)
  await writeFile(temp_file, new Uint8Array(arr_buf))
  return temp_file
}

const unpack_deno_bin: Function = async (temp_dir: string, archive: string) : Promise<void> => {
  var args: string[]
  await mkdirp(DENO_BIN_DIR)  
  if (WIN32) {
    args = await prep_wunzip(temp_dir, archive, DENO_BIN_DIR)
    console.log('DEBUG', args)
  } else {
    args = [ 'gunzip', '-d', archive ]
  }
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
    if (WIN32) return // workaround NOT_IMPLEMENTED error
    await symlink(DENO_BIN, DENO_LINK, WIN32 ? 'file' : undefined)
  }
}

const ck_deno: Function = async (tag: string) : Promise<void> => {
  const deno_proc: Process = run({
    args: [ 'deno', '--version' ],
    stdout: 'piped'
  })
  const deno_status: ProcessStatus = await deno_proc.status()
  if (!deno_status.success) panic(Error('deno test run failed'))
  const deno_stdout: Uint8Array = new Uint8Array(32)
  while ((await deno_proc.stdout.read(deno_stdout)).nread < 16);
  deno_proc.close()
  const output: string = new TextDecoder('utf-8').decode(deno_stdout)
  if (!RegExp(tag.replace(/^v/, '').replace(/\./g, '\\.')).test(output))
    panic(Error('version mismatch'))
}

const main: Function = async () : Promise<void> => {
  var tag: string
  if (/^v\d+\.\d+\.\d+$/.test(args[1])) tag = args[1]
  pinup(tag ? `updating 2 deno ${tag}` : 'updating 2 deno@latest')
  const actual: { [key: string]: string } = await release_url(tag)
  const temp_dir: string = await makeTempDir()
  pinup(`downloading ${actual.url}`)
  const temp_file: string = 
    await temp_download(temp_dir, actual.url, WIN32 ? 'zip' : 'gz')
  await unpack_deno_bin(temp_dir, temp_file)
  pinup('plugging up da binary')
  await mk_handy()
  await ck_deno(actual.tag)
  await removeAll(temp_dir)
  pinup(`update ok`)
}

main()
