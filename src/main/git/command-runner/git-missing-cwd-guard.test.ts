import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetNonRepoFolderVerdictsForTests, noteFolderFocused } from '../non-repo-folder-verdicts'
import { withMissingCwdGuard } from './git-missing-cwd-guard'

const spawnEnoent = (): Error =>
  Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', syscall: 'spawn git' })

// The pollers still hitting deleted folders on the installed build (#857).
const POLLER_ARGS = [
  ['worktree', 'list', '--porcelain', '-z'],
  ['remote', 'get-url', 'upstream'],
  ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'],
  ['config', '--get', 'github.user'],
  ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
  ['branch', '--show-current']
]

describe('withMissingCwdGuard', () => {
  let root: string

  beforeEach(async () => {
    _resetNonRepoFolderVerdictsForTests()
    root = await mkdtemp(join(tmpdir(), 'git-missing-cwd-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('spawns zero times across every caller once a deleted cwd has a verdict', async () => {
    const deleted = join(root, 'wt-livesim')
    const spawn = vi.fn(async (): Promise<void> => {
      throw spawnEnoent()
    })
    await expect(withMissingCwdGuard(POLLER_ARGS[0], { cwd: deleted }, spawn)).rejects.toThrow(
      'spawn git ENOENT'
    )
    expect(spawn).toHaveBeenCalledTimes(1)

    for (let round = 0; round < 3; round++) {
      for (const args of POLLER_ARGS) {
        await expect(withMissingCwdGuard(args, { cwd: deleted }, spawn)).rejects.toMatchObject({
          code: 'ENOENT'
        })
      }
    }
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('spawns again once the folder reappears or gains focus', async () => {
    const folder = join(root, 'worktree')
    const spawn = vi.fn(async (): Promise<void> => {
      throw spawnEnoent()
    })
    await withMissingCwdGuard(POLLER_ARGS[0], { cwd: folder }, spawn).catch(() => {})
    await withMissingCwdGuard(POLLER_ARGS[0], { cwd: folder }, spawn).catch(() => {})
    expect(spawn).toHaveBeenCalledTimes(1)

    noteFolderFocused(folder)
    await withMissingCwdGuard(POLLER_ARGS[0], { cwd: folder }, spawn).catch(() => {})
    expect(spawn).toHaveBeenCalledTimes(2)

    await mkdir(folder)
    spawn.mockResolvedValue(undefined)
    await expect(withMissingCwdGuard(POLLER_ARGS[0], { cwd: folder }, spawn)).resolves.toBe(
      undefined
    )
    expect(spawn).toHaveBeenCalledTimes(3)
  })

  it('keeps retrying a spawn ENOENT while the cwd exists, since git itself may be missing', async () => {
    const spawn = vi.fn(async (): Promise<void> => {
      throw spawnEnoent()
    })
    for (let call = 0; call < 3; call++) {
      await withMissingCwdGuard(POLLER_ARGS[0], { cwd: root }, spawn).catch(() => {})
    }
    expect(spawn).toHaveBeenCalledTimes(3)
  })

  it('leaves WSL-routed commands to their own host', async () => {
    const deleted = join(root, 'gone')
    const spawn = vi.fn(async (): Promise<void> => {
      throw spawnEnoent()
    })
    for (let call = 0; call < 3; call++) {
      await withMissingCwdGuard(POLLER_ARGS[0], { cwd: deleted, wslDistro: 'Ubuntu' }, spawn).catch(
        () => {}
      )
    }
    expect(spawn).toHaveBeenCalledTimes(3)
  })
})
