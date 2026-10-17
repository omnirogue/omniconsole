import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authorizeExternalPath } from '../ipc/filesystem-auth'
import type { IFilesystemProvider } from '../providers/types'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import {
  advanceSshConnectionGeneration,
  resetSshConnectionGenerations
} from '../ssh/ssh-connection-generation'
import { getBrowserClientDownloadTransferStore } from './browser-client-download-transfer-store'
import {
  RuntimeFileCommands,
  type ResolvedRuntimeFileTarget,
  type RuntimeFileCommandHost
} from './omni-runtime-files'

let fixture: string
let workspace: string
let remote: string
let commands: RuntimeFileCommands
let provider: IFilesystemProvider
const transfer = {
  workspaceId: 'workspace-1',
  browserPageId: 'page-1',
  pageHostGeneration: 1,
  filename: 'test.bin',
  transferId: 'first',
  contentBase64: Buffer.from('one').toString('base64'),
  offset: 0,
  final: false,
  platform: process.platform
}
const toRemoteDisk = (path: string) => join(remote, relative(workspace, path))
const downloadPath = (name: string) => join(remote, '.omni', 'browser-downloads', name)

beforeEach(async () => {
  resetSshConnectionGenerations()
  fixture = await realpath(await mkdtemp(join(tmpdir(), 'browser-download-ssh-adapter-')))
  workspace = join(fixture, 'local-shadow')
  remote = join(fixture, 'remote-disk')
  await Promise.all([mkdir(workspace), mkdir(remote)])
  authorizeExternalPath(workspace)
  const target = {
    connectionId: 'download-ssh',
    worktree: {
      id: 'workspace-1',
      repoId: 'repo-1',
      path: workspace,
      hostId: 'ssh:download-ssh'
    }
  } as unknown as ResolvedRuntimeFileTarget
  commands = new RuntimeFileCommands({
    getRuntimeId: () => 'fixture-runtime',
    resolveRuntimeFileTarget: async () => target,
    requireStore: () => {
      throw new Error('SSH must not use the local store or filesystem')
    }
  } as unknown as RuntimeFileCommandHost)
  provider = {
    lstat: vi.fn(async (path: string) => {
      const value = await lstat(toRemoteDisk(path))
      return {
        type: value.isSymbolicLink() ? 'symlink' : value.isDirectory() ? 'directory' : 'file',
        size: value.size,
        mtime: value.mtimeMs,
        dev: value.dev,
        ino: value.ino
      }
    }),
    realpath: vi.fn(async (path: string) =>
      join(workspace, relative(remote, await realpath(toRemoteDisk(path))))
    ),
    createDirNoClobber: vi.fn(async (path: string) => {
      await mkdir(toRemoteDisk(path))
    }),
    writeFileBase64Chunk: vi.fn(async (path: string, content: string, append: boolean) => {
      await writeFile(toRemoteDisk(path), Buffer.from(content, 'base64'), {
        flag: append ? 'a' : 'wx'
      })
    }),
    renameNoClobber: vi.fn(async (source: string, destination: string) => {
      await link(toRemoteDisk(source), toRemoteDisk(destination))
      await unlink(toRemoteDisk(source))
    }),
    deletePath: vi.fn(async (path: string) => {
      await unlink(toRemoteDisk(path))
    }),
    copy: vi.fn(async () => {
      throw new Error('Do not copy after an unsupported safe rename')
    })
  } as unknown as IFilesystemProvider
  registerSshFilesystemProvider('download-ssh', provider)
})
afterEach(async () => {
  await getBrowserClientDownloadTransferStore(commands).releasePage('page-1')
  unregisterSshFilesystemProvider('download-ssh')
  await rm(fixture, { recursive: true, force: true })
})

it('uses the selected SSH provider through the production adapter for every step', async () => {
  const store = getBrowserClientDownloadTransferStore(commands)
  await store.accept(transfer)
  expect(await store.accept({ ...transfer, offset: 3, final: true })).toEqual({
    workspaceRelativePath: '.omni/browser-downloads/test.bin'
  })
  expect(await readFile(downloadPath('test.bin'), 'utf8')).toBe('oneone')
  expect(await readdir(downloadPath(''))).toEqual(['test.bin'])
  expect(await readdir(workspace)).toEqual([])
  expect(provider.createDirNoClobber).toHaveBeenCalledTimes(2)
  expect(provider.renameNoClobber).toHaveBeenCalledTimes(1)
})

it('handles concurrent first downloads without clobbering either result', async () => {
  const store = getBrowserClientDownloadTransferStore(commands)
  await Promise.all([
    store.accept({ ...transfer, final: true }),
    store.accept({
      ...transfer,
      transferId: 'second',
      contentBase64: Buffer.from('two').toString('base64'),
      final: true
    })
  ])
  expect((await readdir(downloadPath(''))).sort()).toEqual(['test (1).bin', 'test.bin'])
  expect(
    new Set(
      await Promise.all(
        ['test.bin', 'test (1).bin'].map((name) => readFile(downloadPath(name), 'utf8'))
      )
    )
  ).toEqual(new Set(['one', 'two']))
  expect(await readdir(workspace)).toEqual([])
})

it('cleans staged SSH bytes on an ordinary abort', async () => {
  const store = getBrowserClientDownloadTransferStore(commands)
  await store.accept(transfer)
  expect(await store.abort({ transferId: 'first', browserPageId: 'page-1' })).toBe(true)
  expect(await readdir(downloadPath(''))).toEqual([])
  expect(provider.deletePath).toHaveBeenCalledTimes(1)
  expect(await readdir(workspace)).toEqual([])
})

it('does not reuse a newer SSH generation for writes or cleanup', async () => {
  const store = getBrowserClientDownloadTransferStore(commands)
  await store.accept(transfer)
  advanceSshConnectionGeneration('download-ssh')
  await expect(store.accept({ ...transfer, offset: 3, final: true })).rejects.toThrow(
    'SSH connection changed'
  )
  expect(provider.writeFileBase64Chunk).toHaveBeenCalledTimes(1)
  expect(provider.deletePath).not.toHaveBeenCalled()
  expect(await readFile(downloadPath('.incoming-first'), 'utf8')).toBe('one')
  expect(await readdir(workspace)).toEqual([])
})

it('refuses a provider replacement even without a generation change', async () => {
  const store = getBrowserClientDownloadTransferStore(commands)
  await store.accept(transfer)
  registerSshFilesystemProvider('download-ssh', { ...provider })
  await expect(store.accept({ ...transfer, offset: 3, final: true })).rejects.toThrow(
    'Workspace changed'
  )
  expect(provider.writeFileBase64Chunk).toHaveBeenCalledTimes(1)
  expect(provider.deletePath).not.toHaveBeenCalled()
})

it('refuses an unavailable provider instead of writing into the local shadow', async () => {
  unregisterSshFilesystemProvider('download-ssh')
  await expect(getBrowserClientDownloadTransferStore(commands).accept(transfer)).rejects.toThrow(
    'Reconnect'
  )
  expect(await readdir(workspace)).toEqual([])
  expect(await readdir(remote)).toEqual([])
})

it.each(['lstat', 'createDirNoClobber', 'renameNoClobber'] as const)(
  'refuses an older provider missing %s without local fallback',
  async (capability) => {
    Object.defineProperty(provider, capability, { value: undefined })
    await expect(getBrowserClientDownloadTransferStore(commands).accept(transfer)).rejects.toThrow(
      'Safe remote downloads are unavailable'
    )
    expect(await readdir(workspace)).toEqual([])
    expect(await readdir(remote)).toEqual([])
  }
)

it('rechecks generation after directory creation and before the first write', async () => {
  vi.mocked(provider.createDirNoClobber).mockImplementation(async (path) => {
    await mkdir(toRemoteDisk(path))
    advanceSshConnectionGeneration('download-ssh')
  })
  await expect(getBrowserClientDownloadTransferStore(commands).accept(transfer)).rejects.toThrow(
    'SSH connection changed'
  )
  expect(provider.writeFileBase64Chunk).not.toHaveBeenCalled()
  expect(provider.deletePath).not.toHaveBeenCalled()
  expect(await readdir(workspace)).toEqual([])
})

it.skipIf(process.platform === 'win32').each(['outside', 'inside'])(
  'refuses a remote directory symlink pointing %s the workspace',
  async (kind) => {
    const real = join(kind === 'outside' ? fixture : remote, 'real')
    await mkdir(real)
    await symlink(real, join(remote, '.omni'))
    await expect(getBrowserClientDownloadTransferStore(commands).accept(transfer)).rejects.toThrow(
      'not a real directory'
    )
    expect(provider.writeFileBase64Chunk).not.toHaveBeenCalled()
    expect(await readdir(real)).toEqual([])
    expect(await readdir(workspace)).toEqual([])
  }
)

it('refuses unsupported safe promotion and removes only its staging file', async () => {
  vi.mocked(provider.renameNoClobber).mockRejectedValue(
    new Error('Remote safe rename is unavailable. Reconnect the SSH target and retry.')
  )
  await expect(
    getBrowserClientDownloadTransferStore(commands).accept({ ...transfer, final: true })
  ).rejects.toThrow('Reconnect')
  expect(provider.copy).not.toHaveBeenCalled()
  expect(await readdir(downloadPath(''))).toEqual([])
  expect(await readdir(workspace)).toEqual([])
})
