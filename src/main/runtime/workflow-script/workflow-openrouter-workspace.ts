import type * as FileSystem from 'node:fs/promises'
import type * as Path from 'node:path'
import type { constants as FsConstants } from 'node:fs'

/** Self-contained so the same implementation runs inside the isolated Node worker. */
export function createOpenRouterWorkspace(
  fs: typeof FileSystem,
  path: typeof Path,
  root: string,
  deadline: number,
  constants: typeof FsConstants
) {
  const MAX_BYTES = 200 * 1024
  const boundary = fs
    .realpath(root)
    .then(async (base) => ({ base, identity: await fs.stat(base) }))
    .catch(() => undefined)
  const assertTime = () => {
    if (Date.now() >= deadline) {
      throw new Error('Workspace deadline reached')
    }
  }
  const confined = async (input: string) => {
    assertTime()
    if (
      path.isAbsolute(input) ||
      input.split(/[\\/]/).includes('..') ||
      input.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')
    ) {
      throw new Error('Path is outside the readable workspace')
    }
    const pinned = await boundary
    if (!pinned) {
      throw new Error('Workspace root is unavailable')
    }
    const { base, identity } = pinned
    const currentRoot = await fs.stat(base)
    if (currentRoot.dev !== identity.dev || currentRoot.ino !== identity.ino) {
      throw new Error('Workspace root changed')
    }
    const target = await fs.realpath(path.resolve(base, input || '.'))
    const relative = path.relative(base, target)
    if (
      base.split(path.sep).some((part) => part.toLowerCase() === '.git') ||
      path.isAbsolute(relative) ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      relative.split(path.sep).some((part) => part.toLowerCase() === '.git')
    ) {
      throw new Error('Path is outside the readable workspace')
    }
    return target
  }
  const read = async (input: string) => {
    const target = await confined(input)
    // O_NOFOLLOW closes the final-component symlink race; verify the descriptor is a regular file.
    const file = await fs.open(
      target,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)
    )
    try {
      const descriptor = await file.stat()
      if (!descriptor.isFile()) {
        throw new Error('Only regular files are readable')
      }
      const current = await fs.stat(await confined(input))
      if (descriptor.dev !== current.dev || descriptor.ino !== current.ino) {
        throw new Error('Workspace path changed')
      }
      if ((await confined(input)) !== target) {
        throw new Error('Workspace path changed')
      }
      const buffer = Buffer.alloc(MAX_BYTES)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await file.close()
    }
  }
  return async (
    name: string,
    args: { path?: string; pattern?: string; start_line?: number; end_line?: number }
  ): Promise<string> => {
    const input = args.path ?? '.'
    if (name === 'read_file') {
      const lines = (await read(input)).split('\n')
      const start = Math.max(1, Math.floor(args.start_line ?? 1))
      const end = Math.max(start, Math.floor(args.end_line ?? lines.length))
      return lines
        .slice(start - 1, end)
        .map((line, index) => `${start + index}: ${line}`)
        .join('\n')
        .slice(0, MAX_BYTES)
    }
    if (name === 'list_directory') {
      const entries = await fs.readdir(await confined(input), { withFileTypes: true })
      return entries
        .filter((entry) => entry.name.toLowerCase() !== '.git')
        .slice(0, 200)
        .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
        .join('\n')
    }
    if (name !== 'search' || typeof args.pattern !== 'string' || !args.pattern.length) {
      throw new Error('Unknown tool or missing search pattern')
    }
    const matches: string[] = []
    let visited = 0
    let bytes = 0
    const walk = async (item: string, depth: number): Promise<void> => {
      assertTime()
      if (matches.length >= 200 || visited++ >= 2000 || depth > 20 || bytes >= MAX_BYTES) {
        return
      }
      const target = await confined(item)
      const stat = await fs.stat(target)
      if (stat.isDirectory()) {
        for (const entry of await fs.readdir(target, { withFileTypes: true })) {
          if (entry.name.toLowerCase() === '.git' || entry.isSymbolicLink()) {
            continue
          }
          await walk(path.join(item, entry.name), depth + 1)
          if (matches.length >= 200 || visited >= 2000 || bytes >= MAX_BYTES) {
            break
          }
        }
      } else if (stat.isFile()) {
        const text = await read(item)
        if (text.includes('\0')) {
          return
        }
        for (const [index, line] of text.split('\n').entries()) {
          if (line.includes(args.pattern!)) {
            const match = `${item}:${index + 1}: ${line.slice(0, 1000)}`
            matches.push(match)
            bytes += Buffer.byteLength(match)
            if (matches.length >= 200 || bytes >= MAX_BYTES) {
              break
            }
          }
        }
      }
    }
    await walk(input, 0)
    return matches.join('\n')
  }
}
