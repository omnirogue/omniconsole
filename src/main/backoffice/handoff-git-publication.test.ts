import { beforeEach, expect, it, vi } from 'vitest'
import { publishHandoffBranch } from './handoff-git-publication'
import { handoffGit } from './handoff-git-exec'
import type * as HandoffGitModule from './handoff-git-exec'

vi.mock('./handoff-git-exec', async (importOriginal) => ({
  ...(await importOriginal<typeof HandoffGitModule>()),
  handoffGit: vi.fn()
}))
const git = vi.mocked(handoffGit)
const sha = 'a'.repeat(40)
const input = {
  repoRoot: '/repo',
  remote: 'upstream',
  fetchUrl: '/repo.git',
  branch: 'handoff/exact',
  sha,
  options: {}
}
const ref = 'refs/heads/handoff/exact'
beforeEach(() => {
  vi.resetAllMocks()
  git.mockResolvedValueOnce('/repo.git')
})

it('accepts a lost push response only when the remote confirms the exact commit', async () => {
  git
    .mockResolvedValueOnce('')
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValueOnce(`${sha}\t${ref}`)
  await expect(publishHandoffBranch(input)).resolves.toBeUndefined()
  expect(git.mock.calls.map(([args]) => args[0])).toEqual([
    'remote',
    'ls-remote',
    'push',
    'ls-remote'
  ])
  expect(git.mock.calls[2]?.[0]).toEqual(['push', '--', 'upstream', `${sha}:${ref}`])
})

it('does not push again when the exact commit is already published', async () => {
  git.mockResolvedValueOnce(`${sha}\t${ref}`)
  await publishHandoffBranch(input)
  expect(git).toHaveBeenCalledTimes(2)
})

it.each(['', `${'b'.repeat(40)}\t${ref}`, `${sha}\trefs/heads/other`])(
  'rejects an absent or different post-push reference',
  async (answer) => {
    git.mockResolvedValueOnce('').mockResolvedValueOnce('').mockResolvedValueOnce(answer)
    await expect(publishHandoffBranch(input)).rejects.toMatchObject({ code: 'push_failed' })
  }
)

it('keeps a lost push and failed reconciliation unverifiable', async () => {
  git
    .mockResolvedValueOnce('')
    .mockRejectedValueOnce(new Error('lost push response'))
    .mockRejectedValueOnce(new Error('network down'))
  await expect(publishHandoffBranch(input)).rejects.toMatchObject({ code: 'push_unverifiable' })
  expect(git).toHaveBeenCalledTimes(4)
})

it.each([`${sha.slice(0, 12)}\t${ref}`, `${sha}\t${ref}\n${sha}\t${ref}`])(
  'refuses malformed or ambiguous remote reference evidence',
  async (answer) => {
    git.mockResolvedValueOnce(answer)
    await expect(publishHandoffBranch(input)).rejects.toMatchObject({ code: 'push_unverifiable' })
    expect(git).toHaveBeenCalledTimes(2)
  }
)

it('refuses ambiguous push destinations before contacting either remote', async () => {
  git.mockReset().mockResolvedValueOnce('/one.git\n/two.git')
  await expect(publishHandoffBranch(input)).rejects.toMatchObject({ code: 'push_unverifiable' })
  expect(git).toHaveBeenCalledTimes(1)
})

it('requires the commit at a distinct push URL even when it is already fetchable', async () => {
  git
    .mockReset()
    .mockResolvedValueOnce('/push.git')
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce(`${sha}\t${ref}`)
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce(`${sha}\t${ref}`)
    .mockResolvedValueOnce(`${sha}\t${ref}`)
  await publishHandoffBranch(input)
  expect(
    git.mock.calls.filter(([args]) => args[0] === 'ls-remote').map(([args]) => args[3])
  ).toEqual(['/push.git', 'upstream', '/push.git', 'upstream'])
  expect(git.mock.calls.some(([args]) => args[0] === 'push')).toBe(true)
})
