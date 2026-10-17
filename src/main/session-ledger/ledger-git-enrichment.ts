import type { LedgerEventDetail } from '../../shared/session-ledger-contract'
import type { LedgerCommitObserver } from './ledger-commit-observer'
import type { LedgerPaneEntry, LedgerPaneRegistry } from './ledger-identity'
import type { LedgerRegisterBinding } from './ledger-register-binding'

export type GitIdentityResolver = (
  cwd: string
) => Promise<{ repo: string | null; branch: string | null }>

/** What git in the pane's cwd adds to a row: its repo/branch, and the commits made in it. */
export class LedgerGitEnrichment {
  constructor(
    private readonly registry: LedgerPaneRegistry,
    private readonly registers: Pick<LedgerRegisterBinding, 'send'>,
    private readonly commits: LedgerCommitObserver,
    private readonly resolveGitIdentity: GitIdentityResolver,
    private readonly enqueue: (entry: LedgerPaneEntry, event: LedgerEventDetail) => void
  ) {}

  async resolveRepo(paneKey: string, cwd: string): Promise<void> {
    try {
      const identity = await this.resolveGitIdentity(cwd)
      const entry = this.registry.get(paneKey)
      if (!entry || entry.cwd !== cwd) {
        return
      }
      if (identity.repo !== entry.repo || identity.branch !== entry.branch) {
        this.registry.update(paneKey, { repo: identity.repo, branch: identity.branch })
        // Why: the row may already exist from a start sent before git answered.
        if (entry.started && identity.repo) {
          void this.registers.send(entry, { repo: identity.repo, branch: identity.branch })
        }
      }
    } catch {
      // a folder workspace, a WSL path or a missing git: the row simply has no repo
    }
  }

  /** Off the hook's path: a commit-class git command finished, so read whether HEAD moved. */
  async observeCommit(paneKey: string, cwd: string): Promise<void> {
    try {
      const event = await this.commits.observe(paneKey, cwd)
      const entry = this.registry.get(paneKey)
      if (event && entry && entry.started && !entry.ended && entry.cwd === cwd) {
        this.enqueue(entry, event)
      }
    } catch {
      // not a local repo, or git is missing: the row simply has no commits
    }
  }
}
