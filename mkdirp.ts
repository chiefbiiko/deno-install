import { ErrorKind, FileInfo, lstat, mkdir, platform } from 'deno'

const PATH_SEPARATOR: string = platform.os === 'win' ? '\\' : '/'

export default async function mkdirp (path: string, mode?: number) : Promise<void> {
  const levels: string[] = path
    .split(/\/|\\/)
    .reduce((acc: string[], _: string, i: number, arr: string[]) : string[] => {
      acc.push(arr.slice(0, i + 1).join(PATH_SEPARATOR))
      return acc
    }, [])
  for (
    var levels_len: number = levels.length,
      level: string, 
      info: FileInfo, 
      i: number = 0; 
    i < levels_len; 
    i++
  ) {
    level = levels[i]
    try {
      info = await lstat(level)
      if (!info.isDirectory()) throw Error(`${level} is not a directory`)
    } catch (err) {
      if (err.kind !== ErrorKind.NotFound) throw err
      await mkdir(level, mode)
    }
  }
}