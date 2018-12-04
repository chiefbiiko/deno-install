import { 
  ErrorKind, 
  Process,
  ProcessStatus,
  copyFile,
  env, 
  exit, 
  lstat, 
  mkdir, 
  platform, 
  writeFile, 
  run, 
  makeTempDir 
} from 'deno'

import mkdirp from 'https://raw.githubusercontent.com/chiefbiiko/deno-mkdirp/master/mkdirp.ts'

const PATH_SEPARATOR: string = platform.os === 'win' ? '\\' : '/'

const path_join: Function = function (...parts: string[]) : string {
  return parts.join(PATH_SEPARATOR)
}

const proc_env: { [key:string]: any } = env()

const get_home: Function = function () : string {
  return platform.os === 'win' ? proc_env.HOMEPATH : proc_env.HOME
}

const DENO_REPO_URL: string = 'https://github.com/denoland/deno'
const LATEST_RELEASE_URL: string = `${DENO_REPO_URL}/releases/latest`
const TAG_RELEASE_URL: string = `${DENO_REPO_URL}/releases/tag`

const DENO_DIR: string = path_join(get_home(), '.deno')
const DENO_BIN_DIR: string = path_join(DENO_DIR, 'bin')
const DENO_BIN: string = path_join(DENO_BIN_DIR, 'deno')

const LINUX_GZ: string = 'deno_linux_x64.gz'
const OSX_GZ: string = 'deno_osx_x64.gz'
const WIN_ZIP: string = 'deno_win_x64.zip'

const panic: Function = (err: Error) : void => {
  if (err) console.error('[deno-self-installer error]', err.stack)
  exit(1)
}

const pinup: Function = (...args: any) : void => {
  console.log('[deno-self-installer info]', ...args)
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

const release_url: Function = async (tag?: string) : Promise<string> => {
  const url: string = tag ? `${TAG_RELEASE_URL}/${tag}` : LATEST_RELEASE_URL
  var filename: string
  switch (platform.os) {
    case 'linux': filename = LINUX_GZ; break
    case 'mac': filename = OSX_GZ; break
    case 'win': filename = WIN_ZIP; break
    default: throw Error(`unsupported OS ${platform.os}`)
  }
  const res: any = await follow(url) // TODO: annotate deno Response
  const link: string = (await res.text())
    .split(/\r?\n/)
    .find((line: string) => line.includes('href') && line.includes(filename))
  if (!link) throw Error(`can't find ${filename} @ ${url}`)
  const match: string = link.replace(/^.*href=(?:"|')([^"']*)(?:"|').*$/, '$1')
  if (!/^\/denoland/.test(match)) throw Error(`can't find ${filename} @ ${url}`)
  return `https://github.com${match}`
}

const temp_download: Function = async (url: string) : Promise<string> => {
  const res: any = await follow(url) // TODO: annotate deno Response
  const arr_buf: ArrayBuffer = await res.arrayBuffer()
  const temp_file: string = `${await makeTempDir()}/${Date.now()}`
  await writeFile(temp_file, new Uint8Array(arr_buf))
  return temp_file
}

const unpack_deno_bin: Function = async (archive: string) : Promise<void> => {
  await mkdirp(DENO_BIN_DIR)
  const args: string[] = [ platform.os === 'win' ? 'unzip.bat' : 'gunzip' ]
    .concat([ archive, DENO_BIN_DIR ])
  const child: Process = run({ args })
  const child_status: ProcessStatus = await child.status()
  if (!child_status.success) 
    throw Error(`(g)unzip failed with code ${child_status.code}`)
  child.close()
}

// release_url().then(console.log)
