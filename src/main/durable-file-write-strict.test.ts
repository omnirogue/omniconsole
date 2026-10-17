import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The file fsync must succeed and the directory fsync must fail: the second fsyncSync per write
// is the directory's (writeFileDurableSync syncs the temp file, renames, then syncs the directory).
const fsync = vi.hoisted(() => ({
  calls: 0,
  failNthWith: null as { n: number; code: string } | null
}))
vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      fsync.calls += 1
      if (fsync.failNthWith && fsync.calls === fsync.failNthWith.n) {
        throw Object.assign(new Error(`${fsync.failNthWith.code}: simulated`), {
          code: fsync.failNthWith.code
        })
      }
      return actual.fsyncSync(fd)
    }
  }
})

import { isDirectorySyncUnsupported, writeFileDurableSync } from './durable-file-write'

const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'durable-strict-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  fsync.calls = 0
  fsync.failNthWith = null
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('writeFileDurableSync strict directory sync', () => {
  it.skipIf(process.platform === 'win32')(
    'surfaces a genuine directory-sync failure when the caller asked for a barrier',
    async () => {
      const dir = await scratch()
      const final = join(dir, 'run.json')
      fsync.failNthWith = { n: 2, code: 'EIO' }
      expect(() =>
        writeFileDurableSync(`${final}.tmp`, final, '{"a":1}', { strictDirectorySync: true })
      ).toThrow(/EIO/)
      expect(fsync.calls).toBe(2)
    }
  )

  it('still swallows the platforms that cannot fsync a directory, even in strict mode', async () => {
    const dir = await scratch()
    const final = join(dir, 'run.json')
    fsync.failNthWith = { n: 2, code: 'EINVAL' }
    expect(() =>
      writeFileDurableSync(`${final}.tmp`, final, '{"a":2}', { strictDirectorySync: true })
    ).not.toThrow()
    expect(await readFile(final, 'utf8')).toBe('{"a":2}')
  })

  it('keeps the best-effort default for every other caller', async () => {
    const dir = await scratch()
    const final = join(dir, 'run.json')
    fsync.failNthWith = { n: 2, code: 'EIO' }
    expect(() => writeFileDurableSync(`${final}.tmp`, final, '{"a":3}')).not.toThrow()
    expect(await readFile(final, 'utf8')).toBe('{"a":3}')
  })
})

describe('isDirectorySyncUnsupported', () => {
  const withCode = (code: string) => Object.assign(new Error(code), { code })

  it('never excuses a failed directory open, on any platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const code of ['EIO', 'ENOENT', 'EACCES', 'EPERM', 'EISDIR']) {
        expect(isDirectorySyncUnsupported(withCode(code), 'open', platform)).toBe(false)
      }
      expect(isDirectorySyncUnsupported(new Error('no code'), 'open', platform)).toBe(false)
    }
  })

  it('excuses only the filesystem\'s own "no directory fsync" answers on POSIX', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(isDirectorySyncUnsupported(withCode('EINVAL'), 'fsync', platform)).toBe(true)
      expect(isDirectorySyncUnsupported(withCode('ENOTSUP'), 'fsync', platform)).toBe(true)
      expect(isDirectorySyncUnsupported(withCode('EOPNOTSUPP'), 'fsync', platform)).toBe(true)
      // A denial or a real I/O failure is heard, not excused.
      for (const code of ['EPERM', 'EACCES', 'EIO', 'ENOSPC', 'EROFS', 'ENOENT']) {
        expect(isDirectorySyncUnsupported(withCode(code), 'fsync', platform)).toBe(false)
      }
      expect(isDirectorySyncUnsupported(new Error('no code'), 'fsync', platform)).toBe(false)
    }
  })

  it('excuses the flush, and only the flush, on Windows', () => {
    // A read handle cannot flush a directory there; the file fsync stays the load-bearing part.
    for (const code of ['EPERM', 'EACCES', 'EIO']) {
      expect(isDirectorySyncUnsupported(withCode(code), 'fsync', 'win32')).toBe(true)
    }
  })
})
