import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listWorktreesStrict } from '../git/worktree'
import {
  _resetNonRepoFolderVerdictsForTests,
  noteFolderFocused
} from '../git/non-repo-folder-verdicts'
import { scanLocalRepoWorktreesForResolution } from './repo-worktree-resolution-scan'

vi.mock('../git/worktree', () => ({ listWorktreesStrict: vi.fn() }))

const notARepoError = Object.assign(
  new Error('Command failed: git worktree list --porcelain -z\nfatal: not a git repository'),
  { code: 128 }
)
const spawnEnoentError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })

describe('scanLocalRepoWorktreesForResolution', () => {
  let root: string

  beforeEach(async () => {
    vi.mocked(listWorktreesStrict).mockReset()
    _resetNonRepoFolderVerdictsForTests()
    root = await mkdtemp(join(tmpdir(), 'non-repo-scan-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('degrades a local Git execution failure instead of reporting an empty success', async () => {
    vi.mocked(listWorktreesStrict).mockRejectedValue(
      Object.assign(new Error('spawn git EAGAIN'), { code: 'EAGAIN' })
    )

    await expect(scanLocalRepoWorktreesForResolution('/repo', {})).resolves.toEqual({
      ok: false,
      worktrees: []
    })
  })

  it('preserves a successful empty scan verdict', async () => {
    vi.mocked(listWorktreesStrict).mockResolvedValue([])

    await expect(
      scanLocalRepoWorktreesForResolution('/repo', { wslDistro: 'Ubuntu' })
    ).resolves.toEqual({ ok: true, worktrees: [] })
    expect(listWorktreesStrict).toHaveBeenCalledWith('/repo', { wslDistro: 'Ubuntu' })
  })

  it('keeps retrying transient failures and real repos on every poll', async () => {
    vi.mocked(listWorktreesStrict).mockRejectedValue(
      Object.assign(new Error('spawn git EAGAIN'), { code: 'EAGAIN' })
    )
    for (let poll = 0; poll < 3; poll++) {
      await scanLocalRepoWorktreesForResolution(root, {})
    }
    vi.mocked(listWorktreesStrict).mockResolvedValue([])
    for (let poll = 0; poll < 3; poll++) {
      await scanLocalRepoWorktreesForResolution(root, {})
    }
    expect(listWorktreesStrict).toHaveBeenCalledTimes(6)
  })

  it('spawns Git once for a non-repo folder until it gains focus or a .git appears', async () => {
    vi.mocked(listWorktreesStrict).mockRejectedValue(notARepoError)
    for (let poll = 0; poll < 10; poll++) {
      await expect(scanLocalRepoWorktreesForResolution(root, {})).resolves.toEqual({
        ok: false,
        worktrees: []
      })
    }
    expect(listWorktreesStrict).toHaveBeenCalledTimes(1)

    noteFolderFocused(root)
    for (let poll = 0; poll < 5; poll++) {
      await scanLocalRepoWorktreesForResolution(root, {})
    }
    expect(listWorktreesStrict).toHaveBeenCalledTimes(2)

    await mkdir(join(root, '.git'))
    vi.mocked(listWorktreesStrict).mockResolvedValue([])
    await expect(scanLocalRepoWorktreesForResolution(root, {})).resolves.toEqual({
      ok: true,
      worktrees: []
    })
    expect(listWorktreesStrict).toHaveBeenCalledTimes(3)
  })

  it('keeps the verdict per execution host', async () => {
    vi.mocked(listWorktreesStrict).mockRejectedValue(notARepoError)
    await scanLocalRepoWorktreesForResolution(root, {})
    await scanLocalRepoWorktreesForResolution(root, { wslDistro: 'Ubuntu' })
    await scanLocalRepoWorktreesForResolution(root, {})
    await scanLocalRepoWorktreesForResolution(root, { wslDistro: 'Ubuntu' })
    expect(listWorktreesStrict).toHaveBeenCalledTimes(2)
  })

  it('drops a deleted folder from polling after one failed spawn', async () => {
    const deleted = join(root, 'deleted-worktree')
    vi.mocked(listWorktreesStrict).mockRejectedValue(spawnEnoentError)
    for (let poll = 0; poll < 10; poll++) {
      await scanLocalRepoWorktreesForResolution(deleted, {})
    }
    expect(listWorktreesStrict).toHaveBeenCalledTimes(1)
  })

  it('retries a spawn ENOENT when the folder exists, since git itself may be missing', async () => {
    vi.mocked(listWorktreesStrict).mockRejectedValue(spawnEnoentError)
    await scanLocalRepoWorktreesForResolution(root, {})
    await scanLocalRepoWorktreesForResolution(root, {})
    expect(listWorktreesStrict).toHaveBeenCalledTimes(2)
  })
})
