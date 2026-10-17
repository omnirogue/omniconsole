import { describe, expect, it, vi } from 'vitest'
import { LedgerCommitObserver, parseCommitSummary } from './ledger-commit-observer'
import { isCompletedGitCommit } from './ledger-lifecycle'

vi.mock('../git/runner', () => ({ gitExecFileAsync: vi.fn() }))

describe('commit observation', () => {
  it('recognises finished commit-class git commands only', () => {
    const finished = (toolInput: string, toolName = 'Bash', hookEventName = 'PostToolUse') =>
      isCompletedGitCommit({ hookEventName, toolName, toolInput })
    expect(finished('git commit -m "x"')).toBe(true)
    expect(finished('git -C /repo commit --amend')).toBe(true)
    expect(finished('pnpm test && git merge feature')).toBe(true)
    expect(finished('git rebase main')).toBe(true)
    expect(finished('git cherry-pick abc')).toBe(true)
    expect(finished('git status')).toBe(false)
    expect(finished('git log --oneline')).toBe(false)
    expect(finished('git commit -m "x"', 'Bash', 'PreToolUse')).toBe(false)
    expect(finished('git commit -m "x"', 'Read')).toBe(false)
    expect(finished('run_shell_command', 'run_shell_command')).toBe(false)
  })

  it('parses the subject and the file count, clipping the subject to the contract', () => {
    expect(parseCommitSummary('feat: x\n\n 2 files changed, 3 insertions(+)')).toEqual({
      subject: 'feat: x',
      files: 2
    })
    expect(parseCommitSummary('one\n\n 1 file changed, 1 deletion(-)')).toEqual({
      subject: 'one',
      files: 1
    })
    expect(parseCommitSummary(`${'s'.repeat(100)}\n`)).toEqual({
      subject: 's'.repeat(80),
      files: 0
    })
    expect(parseCommitSummary('')).toEqual({ subject: '', files: 0 })
  })

  it('reports only a moved HEAD, once, and nothing for an unprimed pane', async () => {
    let head = 'a'.repeat(40)
    const git = vi.fn(async (_cwd: string, args: string[]) =>
      args[0] === 'rev-parse' ? head : 'subject\n\n 1 file changed'
    )
    const observer = new LedgerCommitObserver(git)
    expect(await observer.observe('pane', '/repo')).toBeNull()
    await observer.prime('pane', '/repo')
    expect(await observer.observe('pane', '/repo')).toBeNull()
    head = 'b'.repeat(40)
    expect(await observer.observe('pane', '/repo')).toEqual({
      kind: 'commit',
      detail: { subject: 'subject', files: 1, sha: 'b'.repeat(40) }
    })
    expect(await observer.observe('pane', '/repo')).toBeNull()
    expect(git.mock.calls.every(([cwd]) => cwd === '/repo')).toBe(true)
  })
})
