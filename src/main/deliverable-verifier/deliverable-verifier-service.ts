/**
 * The turn-end deliverable check for ordinary sessions (W22-20 Path B). After a finished turn it
 * builds the request's contract, checks it on the execution host, records what it found and — only
 * in `on` mode, within the budget, and with nothing else driving or asking — queues one repair
 * prompt to the same conversation. A conversation a plan owns is the outcome engine's (Path A).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type {
  DeliverableCheck,
  DeliverableItem,
  DeliverableVerificationRecord
} from '../../shared/deliverable-verification-types'
import type { PromptQueueEnqueueInput, PromptQueueEntry } from '../../shared/prompt-queue-types'
import type { DeliveredFileReading } from '../runtime/delivered-file-read'
import type { FinishedTurn, TurnSignal } from '../next-steps/next-step-turn-signal'
import { replyAsksPerson } from './deliverable-claims'
import { checkDeliverables, type RemoteDeliverableStat } from './deliverable-checks'
import {
  buildDeliverableContract,
  deliverablePathStyle,
  requestDeliverables,
  type DeliverablePathStyle
} from './deliverable-contract'
import {
  decideDeliverableRepair,
  DELIVERABLE_REPAIR_WINDOW_MS,
  deliverableMissing,
  deliverableRepairPrompt,
  parseDeliverableRepairMarker,
  type DeliverableRepairFacts
} from './deliverable-repair'
import {
  deliverableQueueBusy,
  deliverableRepairDeliveryRefusal,
  queuedDeliverableRepair,
  type DeliverableDeliveryReaders
} from './deliverable-repair-delivery'
import {
  buildDeliverableVerificationRecord,
  type DeliverableRecordInput
} from './deliverable-verification-record'

/** Like the steward's: late writes land before the check reads the disk. */
export const DELIVERABLE_CHECK_DELAY_MS = 2_500

export type DeliverableVerifierDeps = DeliverableDeliveryReaders & {
  now: () => number
  schedule: (run: () => void, ms: number) => () => void
  resolveWorkspace: (worktreeId: string) => { path: string; connectionId?: string } | null
  hostLabel: (connectionId: string | null) => string
  /** This computer's home, for `~` paths in a local workspace. */
  home: () => string | null
  caseInsensitive: (style: DeliverablePathStyle, connectionId: string | null) => boolean
  readLocalFile: (path: string) => Promise<DeliveredFileReading>
  readLocalDirectory: (path: string) => Promise<number | null>
  statRemote: (connectionId: string) => ((path: string) => Promise<RemoteDeliverableStat>) | null
  writtenPaths: (paneKey: string) => readonly string[]
  sharedUrls: (paneKey: string, since: number | null) => readonly string[]
  isChainBound: (source: ConversationSource) => boolean
  enqueue: (source: ConversationSource, input: PromptQueueEnqueueInput) => void
}

function requestIdFor(conversationKey: string, turnKey: string): string {
  return createHash('sha256').update(`${conversationKey}\n${turnKey}`).digest('hex').slice(0, 24)
}

/** The pane a row key names (`conversationSourceRowKey`), compared whole, never as a substring. */
function paneOfKey(key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(key)
    return Array.isArray(parsed) && typeof parsed[2] === 'string' ? parsed[2] : null
  } catch {
    return null
  }
}

function asRequested(check: DeliverableCheck): DeliverableItem {
  return { target: check.target, kind: check.kind, source: check.source, claim: 'named' }
}

export class DeliverableVerifierService {
  private readonly requestStarts = new Map<string, number>()
  private readonly timers = new Map<string, () => void>()
  /** Repairs queued whose answering turn has not finished yet. */
  private readonly outstanding = new Map<string, string>()

  constructor(private readonly deps: DeliverableVerifierDeps) {}

  onTurnSignal(signal: TurnSignal): void {
    if (signal.kind === 'ignore' || (signal.kind === 'skip' && !signal.conversation)) {
      return
    }
    const source = signal.kind === 'finished' ? signal.turn.conversation : signal.conversation!
    const key = conversationSourceRowKey(source)
    if (signal.kind === 'busy') {
      if (!this.requestStarts.has(key)) {
        this.requestStarts.set(key, this.deps.now())
      }
      return
    }
    this.timers.get(key)?.()
    this.timers.delete(key)
    this.outstanding.delete(key)
    const startedAt = this.requestStarts.get(key) ?? null
    this.requestStarts.delete(key)
    if (signal.kind === 'skip') {
      return
    }
    const turn = signal.turn
    const cancel = this.deps.schedule(() => {
      this.timers.delete(key)
      void this.verify(turn, startedAt).catch((error: unknown) => {
        console.warn('[deliverable-check] check failed', key, error)
      })
    }, DELIVERABLE_CHECK_DELAY_MS)
    this.timers.set(key, cancel)
  }

  onPaneClosed(paneKey: string): void {
    for (const map of [this.requestStarts, this.outstanding] as Map<string, unknown>[]) {
      for (const key of [...map.keys()].filter((entry) => paneOfKey(entry) === paneKey)) {
        map.delete(key)
      }
    }
    for (const [key, cancel] of this.timers) {
      if (paneOfKey(key) === paneKey) {
        cancel()
        this.timers.delete(key)
      }
    }
  }

  /** One pane's records, newest first, for the session panel. */
  records(paneKey: string): DeliverableVerificationRecord[] {
    return this.deps.store.forPane(paneKey)
  }

  markFalseAlarm(id: string): DeliverableVerificationRecord | null {
    return this.deps.store.markFalseAlarm(id, this.deps.now())
  }

  /** A repair is queued, or sent and its turn not finished: the steward leaves it alone. */
  hasOutstandingRepair(source: ConversationSource): boolean {
    return (
      this.outstanding.has(conversationSourceRowKey(source)) ||
      queuedDeliverableRepair(this.deps.readQueue(source))
    )
  }

  /** Re-read just before the write; any doubt refuses, and the prompt is not sent. */
  assertDelivery(source: ConversationSource, entry: PromptQueueEntry): void {
    const refusal = deliverableRepairDeliveryRefusal(this.deps, source, entry)
    if (refusal) {
      throw new Error(refusal)
    }
  }

  /** One finished turn, checked and recorded. Null when there was nothing to check. */
  async verify(
    turn: FinishedTurn,
    startedAt: number | null
  ): Promise<DeliverableVerificationRecord | null> {
    const settings = this.deps.settings()
    const source = turn.conversation
    if (settings.mode === 'off' || this.deps.isChainBound(source)) {
      return null
    }
    const key = conversationSourceRowKey(source)
    // One reading per turn: a repeated signal for the same turn is never a second attempt.
    if (
      this.deps.store.list().some((r) => r.conversationKey === key && r.turnKey === turn.turnKey)
    ) {
      return null
    }
    const marker = parseDeliverableRepairMarker(turn.lastUserPrompt)
    // A marker this host has no record of (another host's, or one aged out) starts nothing. A turn
    // whose prompt the agent did not report answers the repair this host sent last, if any: it is
    // never read as a fresh request, which would reset the budget.
    const answered = marker
      ? this.deps.store.byToken(key, marker.token)
      : turn.lastUserPrompt?.trim()
        ? null
        : this.unansweredRepair(key)
    const requestId = answered?.requestId ?? requestIdFor(key, turn.turnKey)
    const requestStartedAt = answered ? answered.requestStartedAt : startedAt
    const requested = answered
      ? answered.checks.filter((check) => check.source !== 'claim').map(asRequested)
      : requestDeliverables(marker ? undefined : turn.lastUserPrompt)
    const workspace = this.deps.resolveWorkspace(source.worktreeId)
    const connectionId = workspace?.connectionId ?? null
    const style = workspace ? deliverablePathStyle(workspace.path) : 'posix'
    const contract = buildDeliverableContract({
      requested,
      reply: turn.lastAssistantMessage,
      workspacePath: workspace?.path ?? null,
      style,
      home: connectionId ? null : this.deps.home(),
      caseInsensitive: this.deps.caseInsensitive(style, connectionId)
    })
    if (contract.length === 0) {
      return null
    }
    const ctx = {
      connectionId,
      hostLabel: this.deps.hostLabel(connectionId),
      readLocalFile: this.deps.readLocalFile,
      readLocalDirectory: this.deps.readLocalDirectory,
      statRemote: connectionId ? this.deps.statRemote(connectionId) : null,
      requestStartedAt,
      writtenPaths: new Set(this.deps.writtenPaths(source.paneKey)),
      sharedUrls: new Set(this.deps.sharedUrls(source.paneKey, requestStartedAt))
    }
    const repairsSent = this.repairsSpent(key, requestId)
    const facts = (
      checks: DeliverableRepairFacts['checks'],
      overall: DeliverableRepairFacts['overall']
    ): DeliverableRepairFacts => ({
      mode: settings.mode === 'on' ? 'on' : 'shadow',
      maxRepairs: settings.maxRepairs,
      overall,
      checks,
      repairsSent,
      conversationRepairsInWindow: this.repairsInWindow(key),
      missingBeforeRepair: answered
        ? deliverableMissing(answered.checks).map((c) => c.target)
        : null,
      replyAsksPerson: replyAsksPerson(turn.lastAssistantMessage),
      agentWaiting: this.deps.agentWaiting(source),
      pendingQuestion: this.deps.pendingQuestion(source.paneKey),
      keepGoing: this.deps.isKeepGoingOn(source),
      queuedEntry: deliverableQueueBusy(this.deps.readQueue(source))
    })
    let { checks, overall } = await checkDeliverables(contract, ctx)
    let action = decideDeliverableRepair(facts(checks, overall)).action
    const id = randomUUID()
    const base = () => ({ id, turn, key, connectionId, requestId, requestStartedAt, settings })
    let promptId: string | undefined
    let token: string | undefined
    if (action === 'repair-sent') {
      // The final re-check: a late write, or a person who acted meanwhile, wins over the first read.
      ;({ checks, overall } = await checkDeliverables(contract, ctx))
      const decision = decideDeliverableRepair(facts(checks, overall))
      action = decision.action
      if (action === 'repair-sent') {
        const attempt = repairsSent + 1
        if (!this.deps.store.claimRepair(`${key}\n${requestId}\n${attempt}`)) {
          action = 'skipped:already-claimed'
        } else {
          token = randomBytes(4).toString('hex')
          promptId = `deliverable-repair:${requestId}:${attempt}`
          const text = deliverableRepairPrompt({
            attempt,
            max: settings.maxRepairs,
            token,
            missing: decision.missing,
            checkedAt: this.deps.now()
          })
          // Recorded before the queue sees it: the delivery guard reads this record.
          this.record({ ...base(), checks, overall, action, repairsSent: attempt, promptId, token })
          try {
            this.deps.enqueue(source, {
              id: promptId,
              text,
              automation: { kind: 'deliverable-repair', verificationId: id, attempt }
            })
            this.outstanding.set(key, promptId)
          } catch (error) {
            action = `skipped:not-queued`
            console.warn('[deliverable-check] repair prompt not queued', key, error)
          }
        }
      }
    }
    const spent = promptId ? repairsSent + 1 : repairsSent
    return this.record({ ...base(), checks, overall, action, repairsSent: spent, promptId, token })
  }

  /** The newest check on this conversation, when it sent a repair: nothing has answered it yet. */
  private unansweredRepair(conversationKey: string): DeliverableVerificationRecord | null {
    const last = this.deps.store
      .list()
      .findLast((record) => record.conversationKey === conversationKey)
    return last?.promptId ? last : null
  }

  private repairsInWindow(conversationKey: string): number {
    const since = this.deps.now() - DELIVERABLE_REPAIR_WINDOW_MS
    return this.deps.store
      .list()
      .filter(
        (record) =>
          record.conversationKey === conversationKey &&
          record.promptId !== undefined &&
          record.checkedAt >= since
      ).length
  }

  /** Attempts already spent on a request: every repair whose claim was taken, sent or not. */
  private repairsSpent(conversationKey: string, requestId: string): number {
    return this.deps.store
      .list()
      .filter(
        (record) =>
          record.conversationKey === conversationKey &&
          record.requestId === requestId &&
          record.promptId !== undefined
      ).length
  }

  private record(input: DeliverableRecordInput): DeliverableVerificationRecord {
    const record = buildDeliverableVerificationRecord(input, this.deps.now())
    this.deps.store.add(record)
    return record
  }
}
