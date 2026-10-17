import { LEDGER_DETAIL_LIMITS, type LedgerEventDetail } from '../../shared/session-ledger-contract'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { gitExecFileAsync } from '../git/runner'
import { recordGitFailureInFolder, shouldSkipGitInFolder } from '../git/non-repo-folder-verdicts'

const GIT_OBSERVE_TIMEOUT_MS = 3_000
const SHA_PATTERN = /^[0-9a-f]{7,40}$/

export type GitRead = (cwd: string, args: string[]) => Promise<string | null>

export async function readGitOutput(cwd: string, args: string[]): Promise<string | null> {
  // Why: panes opened in plain folders re-probed git on every spawn and commit hook (#857).
  if (await shouldSkipGitInFolder(LOCAL_EXECUTION_HOST_ID, cwd)) {
    return null
  }
  try {
    return (
      (await gitExecFileAsync(args, { cwd, timeout: GIT_OBSERVE_TIMEOUT_MS })).stdout.trim() || null
    )
  } catch (error) {
    await recordGitFailureInFolder(LOCAL_EXECUTION_HOST_ID, cwd, error)
    return null
  }
}

/** `git log -1 --format=%s --shortstat`: the subject line, then `N files changed, …`. */
export function parseCommitSummary(output: string): { subject: string; files: number } {
  const lines = output.split(/\r?\n/)
  const subject = (lines[0] ?? '').trim().slice(0, LEDGER_DETAIL_LIMITS.subject)
  const stat = lines.slice(1).join('\n')
  const files = /(\d+) files? changed/.exec(stat)
  return { subject, files: files ? Number(files[1]) : 0 }
}

/**
 * Turns "HEAD moved after a git commit-class command" into a `commit` event (contract §8):
 * subject only — never the body — plus sha and file count. Reads git in the pane's cwd, so
 * it only runs for panes whose cwd is on this host (an SSH pane has none and is skipped);
 * every read is bounded and off the hook's path.
 */
export class LedgerCommitObserver {
  private readonly headByPane = new Map<string, string>()
  private readonly inFlight = new Set<string>()

  constructor(private readonly git: GitRead = readGitOutput) {}

  /** Remember where HEAD stands when a pane spawns, so only commits made in it count. */
  async prime(paneKey: string, cwd: string): Promise<void> {
    const head = await this.git(cwd, ['rev-parse', 'HEAD'])
    if (head && SHA_PATTERN.test(head)) {
      this.headByPane.set(paneKey, head)
    }
  }

  forget(paneKey: string): void {
    this.headByPane.delete(paneKey)
  }

  /** The commit HEAD moved to since the last look, or null (unchanged, unprimed, not a repo). */
  async observe(paneKey: string, cwd: string): Promise<LedgerEventDetail | null> {
    const before = this.headByPane.get(paneKey)
    if (!before || this.inFlight.has(paneKey)) {
      return null
    }
    this.inFlight.add(paneKey)
    try {
      const head = await this.git(cwd, ['rev-parse', 'HEAD'])
      if (!head || !SHA_PATTERN.test(head) || head === before) {
        return null
      }
      this.headByPane.set(paneKey, head)
      const summary = await this.git(cwd, ['log', '-1', '--format=%s', '--shortstat', head])
      const { subject, files } = parseCommitSummary(summary ?? '')
      return {
        kind: 'commit',
        detail: { subject, files, sha: head.slice(0, LEDGER_DETAIL_LIMITS.sha) }
      }
    } finally {
      this.inFlight.delete(paneKey)
    }
  }
}
