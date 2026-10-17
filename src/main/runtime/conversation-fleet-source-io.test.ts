import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import { assertFleetSourcePath, createFleetSourceIo } from './conversation-fleet-source-io'

const temporaryRoots: string[] = []
const connectionId = 'source-io-test'

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fleet-source-io-')))
  temporaryRoots.push(root)
  return root
}

function remoteStats(overrides: Partial<FileStat> = {}): FileStat {
  return {
    type: 'file',
    size: 3,
    mtime: 10,
    mtimeMs: 10,
    ctimeMs: 11,
    dev: 1,
    ino: 2,
    mode: 0o100755,
    exactReadIdentity: 1,
    ...overrides
  }
}

function remoteProvider(stat = remoteStats()) {
  const provider = {
    realpath: vi.fn(async (path: string) => path),
    lstat: vi.fn(async () => stat),
    readExactFile: vi.fn(async () => ({ isBinary: true, content: 'AID/' }))
  }
  registerSshFilesystemProvider(connectionId, provider as unknown as IFilesystemProvider)
  return provider
}

afterEach(async () => {
  unregisterSshFilesystemProvider(connectionId)
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('local source snapshots', () => {
  it('captures exact binary and empty bytes with executable metadata', async () => {
    const root = await fixture()
    const path = join(root, 'script')
    const bytes = Buffer.from([0, 128, 255, 10])
    await writeFile(path, bytes)
    if (process.platform !== 'win32') {
      await chmod(path, 0o755)
    }
    const io = createFleetSourceIo()
    const sourcePath = await assertFleetSourcePath(io, root, 'script')
    const stats = await io.lstat(sourcePath)
    expect(stats.type).toBe('file')
    if (process.platform !== 'win32') {
      expect(stats.mode! & 0o111).toBe(0o111)
    }
    expect(await io.readExact(sourcePath, bytes.length, stats)).toEqual(bytes)
    await writeFile(path, '')
    expect(await io.readExact(path, 0)).toEqual(Buffer.alloc(0))
  })

  it('rejects changed expected identity, oversize and nonregular reads', async () => {
    const root = await fixture()
    const path = join(root, 'file')
    await writeFile(path, 'first')
    const io = createFleetSourceIo()
    const initial = await io.lstat(path)
    await writeFile(path, 'new contents')
    await expect(io.readExact(path, 100, initial)).rejects.toThrow('changed')
    await expect(io.readExact(path, 1)).rejects.toThrow('byte limit')
    await expect(io.readExact(root, 100)).rejects.toThrow('regular files')
  })

  it.skipIf(process.platform === 'win32')(
    'rejects symlink leaves and parents even within the worktree',
    async () => {
      const root = await fixture()
      await mkdir(join(root, 'actual'))
      await writeFile(join(root, 'actual', 'file'), 'secret')
      await symlink(join(root, 'actual'), join(root, 'alias'))
      await symlink(join(root, 'actual', 'file'), join(root, 'link'))
      const io = createFleetSourceIo()
      await expect(assertFleetSourcePath(io, root, 'alias/file')).rejects.toThrow('symlink')
      await expect(assertFleetSourcePath(io, root, 'alias/missing', true)).rejects.toThrow(
        'symlink'
      )
      await expect(assertFleetSourcePath(io, root, 'link')).rejects.toThrow('symlink')
      await expect(io.readExact(join(root, 'link'), 100)).rejects.toThrow('regular files')
      await expect(io.readExact(join(root, 'alias', 'file'), 100)).rejects.toThrow('changed')
    }
  )

  it('accepts missing deletions only beneath verified parents and rejects traversal', async () => {
    const root = await fixture()
    const io = createFleetSourceIo()
    expect(await assertFleetSourcePath(io, root, 'removed/child', true)).toBe(
      join(root, 'removed', 'child')
    )
    await expect(assertFleetSourcePath(io, root, 'missing')).rejects.toThrow()
    for (const candidate of [
      '../outside',
      'nested/../outside',
      '/absolute',
      '',
      '.',
      'a\0b',
      'a//b'
    ]) {
      await expect(assertFleetSourcePath(io, root, candidate, true)).rejects.toThrow(
        'Invalid source path'
      )
    }
  })
})

describe('SSH source snapshots', () => {
  it('requires the registered remote host, with no local fallback', async () => {
    expect(() => createFleetSourceIo(connectionId)).toThrow('Reconnect')
    expect(() => createFleetSourceIo('')).toThrow('valid SSH')
    remoteProvider()
    const io = createFleetSourceIo(connectionId)
    unregisterSshFilesystemProvider(connectionId)
    await expect(io.readExact('/source/file', 10)).rejects.toThrow('Reconnect')
  })

  it('binds exact bytes to the expected host identity and preserves executable mode', async () => {
    const provider = remoteProvider()
    const io = createFleetSourceIo(connectionId)
    const stats = await io.lstat('/source/file')
    expect(stats.mode! & 0o111).toBe(0o111)
    expect(await io.readExact('/source/file', 3, stats)).toEqual(Buffer.from([0, 128, 255]))
    expect(provider.readExactFile).toHaveBeenCalledExactlyOnceWith('/source/file', 3, {
      size: 3,
      dev: 1,
      ino: 2,
      mode: 0o100755,
      mtimeMs: 10,
      ctimeMs: 11
    })
  })

  it.each([
    { exactReadIdentity: undefined },
    { mode: undefined },
    { ctimeMs: undefined },
    { ino: undefined },
    { dev: undefined },
    { mtimeMs: undefined }
  ] satisfies Partial<FileStat>[])(
    'requires an update when safe remote identity is unavailable: %j',
    async (override) => {
      const provider = remoteProvider(remoteStats(override))
      await expect(createFleetSourceIo(connectionId).readExact('/source/file', 10)).rejects.toThrow(
        'Update Orca'
      )
      expect(provider.readExactFile).not.toHaveBeenCalled()
    }
  )

  it('rejects mode-identified special files even when a legacy stat labels them files', async () => {
    const provider = remoteProvider(remoteStats({ mode: 0o010644 }))
    const io = createFleetSourceIo(connectionId)
    expect((await io.lstat('/source/pipe')).type).toBe('other')
    await expect(io.readExact('/source/pipe', 10)).rejects.toThrow('regular files')
    expect(provider.readExactFile).not.toHaveBeenCalled()
  })

  it('gives an update action when an old relay has no lstat or SFTP fallback', async () => {
    const provider = remoteProvider()
    provider.lstat.mockRejectedValue(new Error('remote_lstat_unavailable'))
    await expect(createFleetSourceIo(connectionId).readExact('/source/file', 10)).rejects.toThrow(
      'Update Orca'
    )
    expect(provider.readExactFile).not.toHaveBeenCalled()
  })

  it('rejects altered source metadata after the transfer', async () => {
    const provider = remoteProvider()
    provider.lstat
      .mockResolvedValueOnce(remoteStats())
      .mockResolvedValue(remoteStats({ ctimeMs: 12 }))
    await expect(createFleetSourceIo(connectionId).readExact('/source/file', 3)).rejects.toThrow(
      'changed'
    )
  })

  it('rejects provider replacement during transfer', async () => {
    const provider = remoteProvider()
    const io = createFleetSourceIo(connectionId)
    provider.readExactFile.mockImplementation(async () => {
      remoteProvider()
      return { isBinary: true, content: 'AID/' }
    })
    await expect(io.readExact('/source/file', 3)).rejects.toThrow('changed')
  })

  it.each([
    { isBinary: false, content: 'abc' },
    { isBinary: true, content: 'AA==' },
    { isBinary: true, content: '!!!!' },
    { isBinary: true, content: 'AID/AA==' }
  ])('rejects non-exact or oversized remote payloads: %j', async (result) => {
    const provider = remoteProvider()
    provider.readExactFile.mockResolvedValue(result)
    await expect(createFleetSourceIo(connectionId).readExact('/source/file', 3)).rejects.toThrow()
  })
})
