import { describe, expect, it, vi } from 'vitest'

const calls: string[] = []
const answers = vi.hoisted(() => ({
  from: '[]',
  into: '[{"number":3}]',
  upstreamFrom: '[]',
  origin: true as boolean,
  upstream: false as boolean,
  parents: ''
}))
vi.mock('../git/runner', () => ({
  ghExecFileAsync: vi.fn(async (args: string[]) => {
    if (args.includes('--jq')) {
      return { stdout: answers.parents, stderr: '' }
    }
    calls.push(args[1]!)
    const upstream = args[1]!.startsWith('repos/Upstream/') || args[1]!.startsWith('repos/Parent/')
    return {
      stdout: args[1]!.includes('head=')
        ? upstream
          ? answers.upstreamFrom
          : answers.from
        : answers.into,
      stderr: ''
    }
  })
}))
vi.mock('./github-api-repository', () => ({
  resolveGitHubApiRepositoryCandidates: vi.fn(async () => {
    const origin = answers.origin ? { owner: 'omnirogue', repo: 'omni-ide' } : null
    const upstream = answers.upstream ? { owner: 'Upstream', repo: 'omni-ide' } : null
    return { candidates: [upstream, origin].filter(Boolean), headRepo: origin }
  })
}))

const { openGitHubPullRequestsTouching } = await import('./github-open-pull-requests-for-branch')

describe('open pull requests touching a branch', () => {
  it('asks GitHub for open ones from and into the branch', async () => {
    expect(await openGitHubPullRequestsTouching('/repo', 'feat/x')).toEqual({ from: 0, into: 1 })
    expect(calls).toEqual([
      'repos/omnirogue/omni-ide/pulls?state=open&per_page=1&head=omnirogue%3Afeat%2Fx',
      'repos/omnirogue/omni-ide/pulls?state=open&per_page=1&base=feat%2Fx'
    ])
  })

  it('counts a fork branch’s pull request opened into upstream', async () => {
    calls.length = 0
    answers.upstream = true
    answers.upstreamFrom = '[{"number":9}]'
    expect(await openGitHubPullRequestsTouching('/repo', 'feat/x')).toEqual({ from: 1, into: 1 })
    expect(calls[0]).toBe(
      'repos/Upstream/omni-ide/pulls?state=open&per_page=1&head=omnirogue%3Afeat%2Fx'
    )
    answers.upstream = false
  })

  it('counts one opened into origin’s fork parent when no upstream remote is set', async () => {
    calls.length = 0
    answers.parents = 'Parent/omni-ide\nParent/omni-ide\n'
    answers.upstreamFrom = '[{"number":4}]'
    expect(await openGitHubPullRequestsTouching('/repo', 'feat/x')).toEqual({ from: 1, into: 1 })
    expect(calls.filter((call) => call.startsWith('repos/Parent/'))).toHaveLength(1)
    answers.parents = ''
  })

  it('answers null for another forge and throws on an unreadable reply', async () => {
    answers.origin = false
    expect(await openGitHubPullRequestsTouching('/repo', 'feat')).toBeNull()
    answers.origin = true
    answers.from = '{"message":"Bad credentials"}'
    await expect(openGitHubPullRequestsTouching('/repo', 'feat')).rejects.toThrow()
  })
})
