import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Store } from '../persistence'
import { authorizeExternalPath } from '../ipc/filesystem-auth'
import { getBrowserClientDownloadTransferStore } from './browser-client-download-transfer-store'
import {
  RuntimeFileCommands,
  type ResolvedRuntimeFileTarget,
  type RuntimeFileCommandHost
} from './omni-runtime-files'

let fixture: string
let workspace: string
let target: ResolvedRuntimeFileTarget
let commands: RuntimeFileCommands
beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), 'browser-download-adapter-')))
  workspace = join(fixture, 'workspace')
  await mkdir(workspace)
  authorizeExternalPath(workspace)
  target = {
    worktree: { id: 'workspace-1', repoId: 'repo-1', path: workspace }
  } as ResolvedRuntimeFileTarget
  commands = new RuntimeFileCommands({
    getRuntimeId: () => 'fixture-runtime',
    requireStore: () => ({}) as Store,
    resolveRuntimeFileTarget: async () => target
  } as unknown as RuntimeFileCommandHost)
})
afterEach(async () => {
  await getBrowserClientDownloadTransferStore(commands).releasePage('page-1')
  await rm(fixture, { recursive: true, force: true })
})
function chunk(transferId: string, text: string, offset = 0, final = true) {
  return {
    workspaceId: 'workspace-1',
    browserPageId: 'page-1',
    pageHostGeneration: 1,
    filename: 'résumé.bin',
    transferId,
    contentBase64: Buffer.from(text).toString('base64'),
    offset,
    final,
    platform: process.platform
  }
}
const downloadPath = (name: string) => join(workspace, '.omni', 'browser-downloads', name)

it.each(['folder', 'git'])(
  'completes through the production adapter into a %s workspace with missing parents',
  async (kind) => {
    if (kind === 'git') {
      await mkdir(join(workspace, '.git'))
    }
    const store = getBrowserClientDownloadTransferStore(commands)
    await store.accept(chunk('first', 'one\0', 0, false))
    const result = await store.accept(chunk('first', 'two', 4))
    expect(result?.workspaceRelativePath).toBe('.omni/browser-downloads/résumé.bin')
    expect(await readFile(downloadPath('résumé.bin'))).toEqual(Buffer.from('one\0two'))
    expect(await readdir(downloadPath(''))).toEqual(['résumé.bin'])
    expect(store.activeTransferCount()).toBe(0)
  }
)

it('reuses its directory and chooses separate names for simultaneous first downloads', async () => {
  const store = getBrowserClientDownloadTransferStore(commands)
  await Promise.all([
    store.accept(chunk('first', 'first')),
    store.accept(chunk('second', 'second'))
  ])
  expect((await readdir(downloadPath(''))).sort()).toEqual(['résumé (1).bin', 'résumé.bin'])
  expect(
    new Set(
      await Promise.all(
        ['résumé.bin', 'résumé (1).bin'].map((name) => readFile(downloadPath(name), 'utf8'))
      )
    )
  ).toEqual(new Set(['first', 'second']))
  await expect(
    commands.createFileExplorerDir(
      'workspace-1',
      '.omni/browser-downloads',
      undefined,
      undefined,
      'local'
    )
  ).rejects.toThrow('already exists')
})

it('removes its staged bytes on abort without deleting a pre-existing incoming file', async () => {
  const store = getBrowserClientDownloadTransferStore(commands)
  await store.accept(chunk('first', 'partial', 0, false))
  expect(await store.abort({ transferId: 'first', browserPageId: 'page-1' })).toBe(true)
  expect(await readdir(downloadPath(''))).toEqual([])
  await writeFile(downloadPath('.incoming-collision'), 'existing work')
  await expect(store.accept(chunk('collision', 'new'))).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(downloadPath('.incoming-collision'), 'utf8')).toBe('existing work')
})

it('refuses a non-directory parent without touching it', async () => {
  await writeFile(join(workspace, '.omni'), 'existing work')
  await expect(
    getBrowserClientDownloadTransferStore(commands).accept(chunk('first', 'new'))
  ).rejects.toThrow('not a real directory')
  expect(await readFile(join(workspace, '.omni'), 'utf8')).toBe('existing work')
})

it.skipIf(process.platform === 'win32').each(['outside', 'inside'])(
  'refuses a download parent symlink pointing %s the workspace',
  async (kind) => {
    const real = join(kind === 'outside' ? fixture : workspace, 'real')
    await mkdir(real)
    await symlink(real, join(workspace, '.omni'))
    await expect(
      getBrowserClientDownloadTransferStore(commands).accept(chunk('first', 'new'))
    ).rejects.toThrow('not a real directory')
    expect(await readdir(real)).toEqual([])
  }
)

it('retains the captured workspace and host for every chunk and cleanup', async () => {
  const store = getBrowserClientDownloadTransferStore(commands)
  await store.accept(chunk('first', 'one', 0, false))
  const moved = join(fixture, 'moved')
  await mkdir(moved)
  target = { ...target, worktree: { ...target.worktree, path: moved } }
  await expect(store.accept(chunk('first', 'two', 3))).rejects.toThrow('Workspace changed')
  expect(await readdir(moved)).toEqual([])
  expect(await readFile(downloadPath('.incoming-first'), 'utf8')).toBe('one')
  expect(store.activeTransferCount()).toBe(0)
})

it('refuses a change from local to SSH without re-capturing ownership', async () => {
  const store = getBrowserClientDownloadTransferStore(commands)
  await store.accept(chunk('first', 'one', 0, false))
  target = { ...target, connectionId: 'ssh-new' }
  await expect(store.accept(chunk('first', 'two', 3))).rejects.toThrow('Workspace host changed')
  expect(await readFile(downloadPath('.incoming-first'), 'utf8')).toBe('one')
})

it.skipIf(process.platform === 'win32')(
  'refuses a replaced download directory before appending or committing',
  async () => {
    const store = getBrowserClientDownloadTransferStore(commands)
    await store.accept(chunk('first', 'one', 0, false))
    const old = join(workspace, 'old-downloads')
    await rename(downloadPath(''), old)
    await mkdir(downloadPath(''))
    await writeFile(downloadPath('.incoming-first'), 'other work')
    await expect(store.accept(chunk('first', 'two', 3))).rejects.toThrow(
      'changed during the transfer'
    )
    expect(await readFile(join(old, '.incoming-first'), 'utf8')).toBe('one')
    expect(await readFile(downloadPath('.incoming-first'), 'utf8')).toBe('other work')
  }
)
