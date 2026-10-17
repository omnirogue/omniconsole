import { resolve, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { lstat, open, opendir, close } = vi.hoisted(() => ({
  lstat: vi.fn(),
  open: vi.fn(),
  opendir: vi.fn(),
  close: vi.fn()
}))
vi.mock('node:fs/promises', () => ({
  lstat,
  open,
  opendir,
  realpath: async (path: string) => path
}))
vi.mock('./filesystem-auth', () => ({ authorizeExternalPath: vi.fn() }))

import { stageSourcesForRuntimeUpload } from './filesystem-runtime-upload-staging'

const mib = 1024 * 1024
const root = resolve('/audit')
const fileStat = (size: number) => ({
  size,
  ino: 1,
  dev: 1,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false
})
const directoryStat = {
  ...fileStat(0),
  isFile: () => false,
  isDirectory: () => true
}

beforeEach(() => {
  vi.resetAllMocks()
  close.mockResolvedValue(undefined)
  open.mockImplementation(async (path: string) => {
    const stat = await lstat(path)
    return {
      stat: async () => stat,
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Math.max(0, Math.min(length, stat.size - position))
        buffer.fill(0, offset, offset + bytesRead)
        return { buffer, bytesRead }
      },
      close
    }
  })
})

describe('one runtime upload request', () => {
  it('accepts exactly 100 MiB across files and refuses the next byte before opening it', async () => {
    const paths = ['a', 'b', 'c', 'd', 'overflow'].map((name) => join(root, name))
    lstat.mockImplementation(async (path: string) => fileStat(path === paths[4] ? 1 : 25 * mib))
    const sources = await stageSourcesForRuntimeUpload(paths)
    expect(sources.map((source) => source.status)).toEqual([
      'staged',
      'staged',
      'staged',
      'staged',
      'failed'
    ])
    expect(sources[4]).toMatchObject({ reason: 'Remote import is too large' })
    expect(open).toHaveBeenCalledTimes(4)
    expect(open).not.toHaveBeenCalledWith(paths[4], expect.anything())
    expect(close).toHaveBeenCalledTimes(4)
  })

  it('shares the byte budget across selected directories', async () => {
    const dirs = [join(root, 'first'), join(root, 'second')]
    lstat.mockImplementation(async (path: string) =>
      dirs.includes(path) ? directoryStat : fileStat(25 * mib)
    )
    opendir.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        for (const name of ['a', 'b', 'c']) {
          yield { ...fileStat(25 * mib), name }
        }
      }
    }))
    const sources = await stageSourcesForRuntimeUpload(dirs)
    expect(sources.map((source) => source.status)).toEqual(['staged', 'failed'])
    expect(sources[1]).toMatchObject({ reason: 'Remote import is too large' })
    expect(open).toHaveBeenCalledTimes(4)
    expect(close).toHaveBeenCalledTimes(4)
  })

  it('bounds zero-byte entries across directories and closes traversal on refusal', async () => {
    const dirs = [join(root, 'first'), join(root, 'second')]
    const closedDirectories: string[] = []
    lstat.mockImplementation(async (path: string) =>
      dirs.includes(path) ? directoryStat : fileStat(0)
    )
    opendir.mockImplementation(async (path: string) => ({
      async *[Symbol.asyncIterator]() {
        try {
          const count = path === dirs[0] ? 4999 : 5000
          for (let i = 0; i < count; i++) {
            yield { ...fileStat(0), name: String(i) }
          }
        } finally {
          closedDirectories.push(path)
        }
      }
    }))
    const sources = await stageSourcesForRuntimeUpload(dirs)
    expect(sources.map((source) => source.status)).toEqual(['staged', 'failed'])
    expect(sources[1]).toMatchObject({ reason: 'Remote import contains too many files or folders' })
    expect(open).toHaveBeenCalledTimes(9998)
    expect(closedDirectories).toEqual(dirs)
  })

  it('refuses excessive selected sources before inspecting any path', async () => {
    await expect(stageSourcesForRuntimeUpload(Array(101).fill(root))).rejects.toThrow(
      'at most 100 sources'
    )
    expect(lstat).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('bounds a file that grows after its metadata check and closes its handle', async () => {
    lstat.mockResolvedValue(fileStat(4))
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      buffer.fill(0, offset, offset + length)
      return { buffer, bytesRead: length }
    })
    open.mockResolvedValue({ stat: async () => fileStat(4), read, close })
    const sources = await stageSourcesForRuntimeUpload([join(root, 'growing')])
    expect(sources[0]).toMatchObject({ status: 'failed' })
    expect(read.mock.calls.map(([, , length]) => length)).toEqual([4, 1])
    expect(close).toHaveBeenCalledOnce()
  })
})
