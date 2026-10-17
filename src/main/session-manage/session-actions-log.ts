/**
 * `<userData>/session-actions.jsonl`: one line per applied session action (a dry run writes
 * nothing), and one per phase of every organization change (prepared, applied, failed).
 * Append-only and rotated to `.1` past ~2 MB, like the next-step decision log.
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  OrganizationExecutor,
  OrganizationPhase,
  OrganizationTitleOrigin,
  OrganizationTrailBody
} from '../../shared/session-organization-change'
import type {
  SessionManageAction,
  SessionManageActor,
  SessionManageUnattended,
  SessionStewardAudit
} from '../../shared/session-manage-types'
import type {
  HibernationAudit,
  HibernationAuditAction
} from '../../shared/idle-auto-close-settings'

export const SESSION_ACTIONS_FILE = 'session-actions.jsonl'
export const SESSION_ACTIONS_ROTATE_BYTES = 2 * 1024 * 1024

/**
 * A proven pane, the plain CLI, the app's steward, another computer, agent hibernation and the idle
 * rules (`hibernation`), or (organization changes only) the executor kind that acted.
 */
export type SessionActionActor =
  | { paneKey: string; title: string }
  | 'cli'
  | 'steward'
  | 'remote'
  | 'person'
  | 'launch'
  | 'sync'
  | 'app'
  | 'hibernation'
  /** A decision on a review page this desktop published woke or removed its session. */
  | 'artifact-review'
  /** A reply on work this session owns (a Jira QA comment) reopened or reached it. */
  | 'work-delivery'
  /** An answered decision or question brought its deleted or hidden conversation back. */
  | 'answer-delivery'

export type SessionActionRecord = {
  ts: string
  actor: SessionActionActor
  /** A pane the caller named but the host could not verify; never taken as the actor. */
  unverifiedPaneKey?: string
  /** `actor: steward` only: which of its paths acted. */
  steward?: SessionStewardAudit
  /** A pane or CLI that acted with no person present (an automatic cleanup session). */
  unattended?: SessionManageUnattended
  /** `actor: remote` only: the computer and requester this host derived from its transport. */
  remote?: SessionActionRemoteAudit
  /** `actor: hibernation` only: which rule decided, in which mode, and the evidence it read. */
  hibernation?: HibernationAudit
  /** `actor: artifact-review` only: the page and revision whose decision acted. */
  artifactReview?: { slug: string; revision: number; decisionId?: string; by?: string }
  /** `actor: work-delivery` only: the OmniOS delivery that acted. */
  workDelivery?: { key: string; workItem: string }
  /** `actor: answer-delivery` only: the delivery whose answer acted and who approved it. */
  answerDelivery?: { deliveryKey: string; approvedBy: string }
  action: SessionManageAction | OrganizationAuditAction | HibernationAuditAction
  target: { paneKey?: string | null; tabId?: string | null; title?: string; folder?: string }
  before?: unknown
  after?: unknown
  summary: string
  reason?: string
  /** The person's own words that asked for this. */
  request?: string
  // Organization changes only (session-organization-change.ts); older lines have none of these.
  opId?: string
  phase?: OrganizationPhase
  executor?: OrganizationExecutor
  origin?: OrganizationTitleOrigin
  revision?: string
  expectedRevision?: string
  organization?: OrganizationTrailBody
}

export type SessionActionAppend = Omit<SessionActionRecord, 'ts'> & { ts?: string }

/** Organization kinds with no `sessionManage` action of their own. */
export type OrganizationAuditAction =
  | 'session.save'
  | 'session.finish'
  | 'session.tag'
  | 'session.untag'
  | 'session.hide'
  | 'session.unhide'
  | 'session.snooze'
  /** An archive put the conversation's idle agent to sleep; opening it resumes. */
  | 'session.sleep'

export class SessionActionsLog {
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  get path(): string {
    return join(this.directory, SESSION_ACTIONS_FILE)
  }

  /** Resolves with an error message when the line could not be written; later appends still run. */
  append(record: SessionActionAppend): Promise<string | undefined> {
    return this.appendStrict(record).then(
      () => undefined,
      (error: unknown) =>
        `The action ran, but the audit log could not be written: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  /** Rejects when the line could not be written (a change that must be recorded before it runs). */
  appendStrict(record: SessionActionAppend): Promise<void> {
    const { ts, ...rest } = record
    const line = `${JSON.stringify({ ts: ts ?? this.now().toISOString(), ...rest })}\n`
    const write = this.chain.then(() => this.appendLine(line))
    this.chain = write.catch(() => {})
    return write.catch((error: unknown) => {
      console.error(`[session-manage] appending to ${this.path} failed`, error)
      throw error
    })
  }

  flush(): Promise<void> {
    return this.chain
  }

  private async appendLine(line: string): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const size = await stat(this.path).then(
      (info) => info.size,
      () => 0
    )
    if (size > 0 && size + Buffer.byteLength(line) > SESSION_ACTIONS_ROTATE_BYTES) {
      await rename(this.path, `${this.path}.1`)
    }
    await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 })
  }
}

export type SessionActionRemoteAudit = Pick<
  Extract<SessionManageActor, { kind: 'remote' }>,
  'computer' | 'peer' | 'requester' | 'title'
>

export type SessionActionAuditActor = Pick<
  SessionActionRecord,
  'actor' | 'unverifiedPaneKey' | 'steward' | 'unattended' | 'remote'
>

/**
 * The audit shape of an actor: `{ paneKey, title }` for a proven pane, `steward` with its path for
 * the app's steward, else `cli`; an unattended pane or CLI says so.
 */
export function auditActor(actor: SessionManageActor): SessionActionAuditActor {
  if (actor.kind === 'steward') {
    return {
      actor: 'steward',
      steward:
        actor.feature === 'suggestion'
          ? { feature: 'suggestion', suggestionId: actor.suggestionId }
          : { feature: actor.feature, ...(actor.runId ? { runId: actor.runId } : {}) }
    }
  }
  const unattended = actor.unattended ? { unattended: actor.unattended } : {}
  if (actor.kind === 'remote') {
    const { computer, peer, requester, title } = actor
    return { actor: 'remote', remote: { computer, peer, requester, title }, ...unattended }
  }
  if (actor.kind === 'pane') {
    return { actor: { paneKey: actor.paneKey, title: actor.title }, ...unattended }
  }
  return {
    actor: 'cli',
    ...(actor.unverifiedPaneKey ? { unverifiedPaneKey: actor.unverifiedPaneKey } : {}),
    ...unattended
  }
}

const logs = new Map<string, SessionActionsLog>()

/** One log per profile directory, so appends from concurrent commands stay in order. */
export function sessionActionsLogFor(directory: string): SessionActionsLog {
  let log = logs.get(directory)
  if (!log) {
    log = new SessionActionsLog(directory)
    logs.set(directory, log)
  }
  return log
}
