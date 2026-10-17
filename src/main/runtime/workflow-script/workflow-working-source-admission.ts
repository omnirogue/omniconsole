import { realpath } from 'node:fs/promises'
import { runProcess } from '../../../shared/child-process/run-process'
import { workflowEvidenceDigest } from './workflow-evidence-digest'

/** What a refusal says; working agents and Improve's private copies need the same clean commit. */
export type GitSourceWords = {
  unavailable: string
  notRoot: string
  noCommit: string
  dirty: string
}

const WORKING_WORDS: GitSourceWords = {
  unavailable: 'Working agents require a local Git worktree with inspectable source state',
  notRoot: 'Working agents require the selected Git worktree root',
  noCommit: 'Working agents require a pinned Git commit',
  dirty:
    'Working agents cannot see uncommitted or untracked source changes in new child worktrees. Commit or stash those changes, then start the workflow again.'
}

async function git(cwd: string, args: string[], unavailable: string): Promise<string> {
  try {
    const result = await runProcess({
      program: 'git',
      args,
      cwd,
      timeoutMs: 15_000,
      maxOutputBytes: 1024 * 1024
    })
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated || result.stderrTruncated) {
      throw new Error('Git inspection failed or exceeded its output limit')
    }
    return result.stdout.trim()
  } catch {
    throw new Error(unavailable)
  }
}

/** Child workers branch from HEAD; refuse changes they would silently miss. */
export async function admitWorkingAgentGitSource(
  workspacePath: string,
  words: GitSourceWords = WORKING_WORDS
): Promise<{ sourceBase: string; sourceDiffDigest: string }> {
  const root = await realpath(workspacePath)
  const topLevel = await realpath(
    await git(root, ['rev-parse', '--show-toplevel'], words.unavailable)
  )
  if (topLevel !== root) {
    throw new Error(words.notRoot)
  }
  const sourceBase = await git(root, ['rev-parse', '--verify', 'HEAD'], words.unavailable)
  if (!/^[a-f0-9]{40,64}$/.test(sourceBase)) {
    throw new Error(words.noCommit)
  }
  const status = await git(
    root,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    words.unavailable
  )
  if (status) {
    throw new Error(words.dirty)
  }
  return { sourceBase, sourceDiffDigest: workflowEvidenceDigest('') }
}
