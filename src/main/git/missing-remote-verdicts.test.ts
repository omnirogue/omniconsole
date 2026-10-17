import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { _resetMissingRemoteVerdictsForTests } from './missing-remote-verdicts'
import { readRemoteUrl } from './remote-url-probe'
import { isStableMissingGitRemoteError } from './stable-missing-git-remote-error'

const noSuchRemote = (): Error =>
  Object.assign(
    new Error("Command failed: git remote get-url upstream\nerror: No such remote 'upstream'"),
    {
      code: 2,
      stderr: "error: No such remote 'upstream'\n"
    }
  )

describe('readRemoteUrl missing-remote cache', () => {
  let repo: string

  beforeEach(async () => {
    gitExecFileAsyncMock.mockReset()
    _resetMissingRemoteVerdictsForTests()
    repo = await mkdtemp(join(tmpdir(), 'missing-remote-'))
    await mkdir(join(repo, '.git'))
    await writeFile(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = a\n')
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('asks git once while the repo config is unchanged, then again after it changes', async () => {
    gitExecFileAsyncMock.mockRejectedValue(noSuchRemote())
    for (let poll = 0; poll < 5; poll++) {
      const error = await readRemoteUrl({ repoPath: repo }, 'upstream').catch((e: unknown) => e)
      expect(isStableMissingGitRemoteError(error)).toBe(true)
    }
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)

    await writeFile(
      join(repo, '.git', 'config'),
      '[remote "origin"]\n\turl = a\n[remote "upstream"]\n\turl = b\n'
    )
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'b\n', stderr: '' })
    await expect(readRemoteUrl({ repoPath: repo }, 'upstream')).resolves.toBe('b\n')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('never caches a transient failure', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('timed out'))
    for (let poll = 0; poll < 3; poll++) {
      await readRemoteUrl({ repoPath: repo }, 'upstream').catch(() => {})
    }
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })
})
