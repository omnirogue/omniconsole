/**
 * The questions sessions asked the person, on this host's own disk (`session-decisions.json`), so a
 * question outlives the terminal that asked it. The hook server's status row is the live truth
 * while the agent waits; this keeps the same question after the agent exits, its terminal dies or
 * the app restarts, until the session moves on (answered in the terminal or anywhere else), the
 * person answers or dismisses it here. Age and queue size are not evidence of an answer.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeHookEventName } from '../../shared/agent-hook-listener/provider-event-names'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { pendingSessionAsk } from '../../shared/session-questions'
import {
  SESSION_DECISION_CONTEXT_CHARS,
  type DecisionScores,
  type SessionDecisionRecord
} from '../../shared/session-decisions'
import { CoalescedWrite, type CoalescedWriteTiming } from '../coalesced-state-write'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

export const SESSION_DECISIONS_FILE = 'session-decisions.json'

// Why: hook events touch a pending question many times a minute; bound the fsync rewrites (#857).
export const SESSION_DECISION_WRITE_TIMING: CoalescedWriteTiming = {
  debounceMs: 500,
  maxWaitMs: 5_000,
  burst: 3,
  refillMs: 10_000
}

type StoredFile = { version: 1; records: SessionDecisionRecord[] }

/** Events that can arrive while a question is still open without meaning it was answered. */
const NOT_MOVING_ON = new Set([
  'subagent_start',
  'subagent_stop',
  'teammate_idle',
  'post_compact',
  'pre_compact',
  'notification'
])

/** One question's identity: the provider conversation plus the tool call that asked it. */
export function sessionDecisionKey(
  paneKey: string,
  sessionId: string | null,
  toolUseId: string | null,
  interactivePrompt: string
): string {
  const ask = toolUseId || createHash('sha256').update(interactivePrompt).digest('hex').slice(0, 16)
  return `${sessionId || paneKey}:${ask}`
}

function clip(text: string | undefined): string | null {
  const value = text?.trim()
  if (!value) {
    return null
  }
  return value.length <= SESSION_DECISION_CONTEXT_CHARS
    ? value
    : `…${value.slice(value.length - SESSION_DECISION_CONTEXT_CHARS + 1)}`
}

function isRecord(value: unknown): value is SessionDecisionRecord {
  const row = value as Partial<SessionDecisionRecord> | null
  return (
    !!row &&
    typeof row.key === 'string' &&
    typeof row.paneKey === 'string' &&
    typeof row.interactivePrompt === 'string' &&
    typeof row.askedAt === 'number' &&
    typeof row.updatedAt === 'number'
  )
}

/** Equal apart from updatedAt. */
function sameDecision(left: SessionDecisionRecord, right: SessionDecisionRecord): boolean {
  return JSON.stringify({ ...left, updatedAt: 0 }) === JSON.stringify({ ...right, updatedAt: 0 })
}

export class SessionDecisionStore {
  private readonly path: string
  private records = new Map<string, SessionDecisionRecord>()
  private readonly writer: CoalescedWrite
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      directory: string
      now?: () => number
      writeTiming?: CoalescedWriteTiming
      /** Whether this pane's live hook status still shows exactly this question pending. */
      paneStillAsking?: (paneKey: string, interactivePrompt: string) => boolean
    }
  ) {
    this.path = join(options.directory, SESSION_DECISIONS_FILE)
    this.writer = new CoalescedWrite(
      options.writeTiming ?? SESSION_DECISION_WRITE_TIMING,
      () => this.startWrite(),
      options.now
    )
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredFile>
      for (const row of Array.isArray(parsed.records) ? parsed.records : []) {
        if (isRecord(row)) {
          this.records.set(row.key, row)
        }
      }
    } catch {
      // Why: a missing or unreadable file is an empty list, never a startup failure.
    }
  }

  list(): SessionDecisionRecord[] {
    return [...this.records.values()]
  }

  get(key: string): SessionDecisionRecord | undefined {
    return this.records.get(key)
  }

  /** One enriched hook status: a question asked (kept), or the pane moved past it (dropped). */
  observe(event: AgentHookEventPayload, askedAt?: number): void {
    // Why: stale evidence cannot create, replace or resolve attention. In particular, a cached
    // pending ask must not resurrect a question that was already answered or dismissed.
    if (event.isReplay || event.restoredUnconfirmed) {
      return
    }
    const { payload } = event
    const ask = pendingSessionAsk(payload)
    const sessionId = event.providerSession?.id ?? null
    if (ask && payload.interactivePrompt) {
      // Why: later events about the same question (a permission prompt, a restart, or an async
      // question that stays open while the agent keeps calling tools, each with its own tool id)
      // keep the identity it was first listed under — also from another pane of the same
      // conversation, where a resume repeats the question without the tool id that asked it.
      const same = this.list().find(
        (row) =>
          row.interactivePrompt === payload.interactivePrompt &&
          (row.paneKey === event.paneKey || (!!sessionId && row.providerSession?.id === sessionId))
      )
      const key =
        same?.key ??
        sessionDecisionKey(
          event.paneKey,
          sessionId,
          event.toolUseId?.trim() || null,
          payload.interactivePrompt
        )
      // Why: a pane asks one question at a time; a new one replaces any older one it asked.
      this.drop((row) => row.paneKey === event.paneKey && row.key !== key)
      this.upsert(event, key, sessionId, askedAt, same)
      return
    }
    // Why: identity-only updates and a subagent's own events do not resolve the main question.
    if (event.providerSessionOnly || event.toolAgentId) {
      return
    }
    const name = normalizeHookEventName(event.hookEventName)
    if (NOT_MOVING_ON.has(name)) {
      return
    }
    if (name === 'session_start') {
      // Why: a resumed conversation still owes its answer; a new one in the pane does not.
      this.drop(
        (row) =>
          row.paneKey === event.paneKey && (!sessionId || row.providerSession?.id !== sessionId)
      )
      // Why ended: the process that asked is gone (or its turn moved past it), so the conversation
      // takes the answer as its next message; a still-waiting selector never sees a SessionStart.
      this.markPaneEnded(event.paneKey)
      return
    }
    // The agent acted after asking (in this pane, or resumed elsewhere): answered or abandoned there.
    this.drop((row) =>
      row.paneKey === event.paneKey
        ? !sessionId || !row.providerSession || row.providerSession.id === sessionId
        : // Why not while the asking pane still waits: a second live process on the same
          // conversation (a duplicate resume) acting elsewhere does not answer the prompt that
          // still holds the first; the question leaves when that pane answers or ends.
          !!sessionId && row.providerSession?.id === sessionId && !this.stillAsking(row)
    )
  }

  private stillAsking(row: SessionDecisionRecord): boolean {
    return (
      row.endedAt === null &&
      (this.options.paneStillAsking?.(row.paneKey, row.interactivePrompt) ?? false)
    )
  }

  private upsert(
    event: AgentHookEventPayload,
    key: string,
    sessionId: string | null,
    askedAt?: number,
    carried?: SessionDecisionRecord
  ): void {
    const { payload } = event
    const existing = this.records.get(key) ?? carried
    // Why: the agent exiting with the question open arrives as a provider-session-only copy.
    const ended = event.providerSessionOnly ? (existing?.endedAt ?? this.now()) : null
    const record: SessionDecisionRecord = {
      key,
      // Why: the same question seen from a second pane (the conversation resumed there, with the
      // asking pane still open) stays with the pane that asked; an ended pane hands it over.
      paneKey:
        existing && existing.paneKey !== event.paneKey && this.stillAsking(existing)
          ? existing.paneKey
          : event.paneKey,
      worktreeId: event.worktreeId ?? existing?.worktreeId ?? null,
      agent: payload.agentType ?? existing?.agent ?? null,
      askedAt: existing?.askedAt ?? askedAt ?? this.now(),
      toolUseId: existing?.toolUseId || event.toolUseId?.trim() || null,
      toolName: payload.toolName ?? existing?.toolName ?? null,
      interactivePrompt: payload.interactivePrompt ?? existing?.interactivePrompt ?? '',
      context: clip(payload.lastAssistantMessage) ?? existing?.context ?? null,
      providerSession: event.providerSession ?? existing?.providerSession ?? null,
      endedAt: ended,
      scores: existing?.scores ?? null,
      scoreFailure: existing?.scoreFailure ?? null,
      updatedAt: existing?.updatedAt ?? this.now()
    }
    if (sessionId === null && existing?.providerSession) {
      record.providerSession = existing.providerSession
    }
    // Why: nothing reads updatedAt to judge liveness, and a pending question is re-observed on every
    // tool event; an unchanged record must not stamp a new time or rewrite the file (#857).
    if (this.records.get(key) && sameDecision(this.records.get(key)!, record)) {
      return
    }
    record.updatedAt = this.now()
    this.records.set(key, record)
    this.scheduleWrite()
  }

  /** The pane's terminal or agent is gone: its open question stays, marked ended. */
  markPaneEnded(paneKey: string): void {
    let changed = false
    for (const row of this.records.values()) {
      if (row.paneKey === paneKey && row.endedAt === null) {
        row.endedAt = this.now()
        row.updatedAt = this.now()
        changed = true
      }
    }
    if (changed) {
      this.scheduleWrite()
    }
  }

  private drop(which: (row: SessionDecisionRecord) => boolean): void {
    let changed = false
    // Why no copy: a Map tolerates deleting the entry its iterator is on.
    for (const row of this.records.values()) {
      if (which(row)) {
        this.records.delete(row.key)
        changed = true
      }
    }
    if (changed) {
      this.scheduleWrite()
    }
  }

  /** Answered through the box's own path, or dismissed by the person. */
  remove(key: string): boolean {
    const removed = this.records.delete(key)
    if (removed) {
      this.scheduleWrite()
    }
    return removed
  }

  setScores(key: string, scores: DecisionScores | null, failure: string | null): void {
    const row = this.records.get(key)
    if (!row) {
      return
    }
    row.scores = scores
    row.scoreFailure = failure ? { reason: failure, at: this.now() } : null
    this.scheduleWrite()
  }

  private scheduleWrite(): void {
    this.writer.schedule()
  }

  /** Write any pending save now and wait for every write in flight (quit). */
  async flush(): Promise<void> {
    this.writer.flush()
    await this.writing
  }

  private startWrite(): void {
    const payload = JSON.stringify({
      version: 1,
      records: this.list()
    } satisfies StoredFile)
    this.writing = this.writing
      .then(async () => {
        await mkdir(this.options.directory, { recursive: true })
        await writeFileDurable(durableWriteTempPath(this.path), this.path, payload)
      })
      .catch((error) => console.error('[session-decisions] could not save', error))
  }
}
