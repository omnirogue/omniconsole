import { z } from 'zod'

/**
 * A requirement only a person can meet, stated so they can meet it. "Needs you" is read from VALID
 * OPEN requests and from nothing else: a blocked, idle, crashed or silent run is never one
 * (`docs/reference/session-run-lifecycle.md`).
 */
export const HUMAN_ATTENTION_KINDS = [
  'clarification',
  'decision',
  'approval',
  'permission',
  'credential',
  'review'
] as const
export type HumanAttentionKind = (typeof HUMAN_ATTENTION_KINDS)[number]

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const sentence = z.string().trim().min(1).max(2_000)
const label = z.string().trim().min(1).max(200)
const at = z.number().finite().nonnegative()

export const humanAttentionRequestSchema = z
  .object({
    id,
    kind: z.enum(HUMAN_ATTENTION_KINDS),
    scope: z
      .object({
        outcomeId: id,
        outcomeRevision: z.number().int().positive(),
        planVersion: z.number().int().positive().optional(),
        stepId: id.optional(),
        attemptId: id.optional(),
        conditionId: id.optional()
      })
      .strict(),
    /** Exactly what the person must provide. */
    ask: sentence,
    /** Why authorized autonomous continuation is impossible. */
    why: sentence,
    recipient: z.discriminatedUnion('type', [
      z.object({ type: z.literal('owner') }).strict(),
      z.object({ type: z.literal('person'), employeeId: label, name: label.optional() }).strict()
    ]),
    /** The direct way to resolve it; absent only when no surface can take the person there. */
    action: z
      .object({
        kind: z.enum(['open-conversation', 'review-outcome', 'open-up-next', 'sign-in']),
        label,
        paneKey: label.optional(),
        conditionId: id.optional()
      })
      .strict()
      .optional(),
    source: z
      .object({
        type: z.enum([
          'agent-prompt',
          'review-condition',
          'review-findings',
          'verification-gate',
          'provider-authentication',
          'provider-usage-limit',
          'provider-approval',
          'principal',
          'brief-too-large'
        ]),
        ref: sentence
      })
      .strict(),
    state: z.enum(['open', 'resolved', 'withdrawn']),
    openedAt: at,
    resolvedAt: at.optional(),
    resolution: label.optional(),
    /** Stamped once, by the host, when the request was announced; a reconnect never re-announces. */
    notifiedAt: at.optional()
  })
  .strict()
export type HumanAttentionRequest = z.infer<typeof humanAttentionRequestSchema>
export type HumanAttentionDraft = Omit<
  HumanAttentionRequest,
  'id' | 'state' | 'openedAt' | 'resolvedAt' | 'resolution' | 'notifiedAt'
>

/** Settled requests kept for the record; the oldest settled ones fall off first. */
export const HUMAN_ATTENTION_HISTORY_MAX = 64

type AttentionHost = {
  attention?: HumanAttentionRequest[]
  outcomes: readonly { id: string; revision: number; status: string }[]
  attempts: readonly { id: string; state: string; planVersion?: number }[]
}

const SCOPE_KEYS = [
  'outcomeId',
  'outcomeRevision',
  'planVersion',
  'stepId',
  'attemptId',
  'conditionId'
] as const

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Small stable text hash (FNV-1a): ids must not carry a prompt, only be stable for it. */
function hash(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** One id per requirement: the same unmet requirement re-observed is the same request. */
export function humanAttentionId(draft: Pick<HumanAttentionDraft, 'source' | 'scope'>): string {
  const scope = draft.scope
  const owner = scope.attemptId ?? scope.conditionId ?? scope.stepId ?? scope.outcomeId
  return `att_${slug(draft.source.type)}_${slug(owner).slice(0, 64)}_${hash(
    JSON.stringify([draft.source.ref, scope.outcomeId, scope.outcomeRevision])
  )}`.slice(0, 128)
}

function trimmed(requests: HumanAttentionRequest[]): HumanAttentionRequest[] {
  const settled = requests.filter((entry) => entry.state !== 'open')
  const drop = new Set(
    settled
      .slice(0, Math.max(0, requests.length - HUMAN_ATTENTION_HISTORY_MAX))
      .map((entry) => entry.id)
  )
  return drop.size ? requests.filter((entry) => !drop.has(entry.id)) : requests
}

/**
 * Open a request for an unmet requirement. Idempotent: an open request with this id is left as it
 * is (its `openedAt` and `notifiedAt` stand), so a retry, a restart or a reconnect asks nobody twice.
 * A settled request with this id opens again only because the requirement is unmet AGAIN. A pass
 * opens what it derived FIRST and reconciles second, so a requirement that moved is never withdrawn.
 */
export function openHumanAttention<T extends AttentionHost>(
  set: T,
  draft: HumanAttentionDraft,
  now: number
): { set: T; id: string; opened: boolean } {
  const requestId = humanAttentionId(draft)
  const existing = set.attention?.find((entry) => entry.id === requestId)
  if (existing?.state === 'open') {
    if (SCOPE_KEYS.every((key) => existing.scope[key] === draft.scope[key])) {
      return { set, id: requestId, opened: false }
    }
    // The same requirement under a newer plan version or step: follow it there instead of letting
    // it go stale and asking (and announcing) a second time. `openedAt` and `notifiedAt` stand.
    const moved = humanAttentionRequestSchema.parse({
      ...draft,
      id: requestId,
      state: 'open',
      openedAt: existing.openedAt,
      ...(existing.notifiedAt === undefined ? {} : { notifiedAt: existing.notifiedAt })
    })
    return {
      set: {
        ...set,
        attention: set.attention!.map((entry) => (entry.id === requestId ? moved : entry))
      },
      id: requestId,
      opened: false
    }
  }
  const request = humanAttentionRequestSchema.parse({
    ...draft,
    id: requestId,
    state: 'open',
    openedAt: now
  })
  const rest = (set.attention ?? []).filter((entry) => entry.id !== requestId)
  return { set: { ...set, attention: trimmed([...rest, request]) }, id: requestId, opened: true }
}

/** The schema refuses an empty label, and an unreadable request would cost the whole plan. */
function resolutionLabel(value: string, state: 'resolved' | 'withdrawn'): string {
  return value.trim().slice(0, 200).trim() || (state === 'resolved' ? 'Resolved.' : 'Withdrawn.')
}

function settle<T extends AttentionHost>(
  set: T,
  matches: (request: HumanAttentionRequest) => boolean,
  state: 'resolved' | 'withdrawn',
  resolution: string,
  now: number
): T {
  const requests = set.attention ?? []
  if (!requests.some((entry) => entry.state === 'open' && matches(entry))) {
    return set
  }
  return {
    ...set,
    attention: requests.map((entry) =>
      entry.state === 'open' && matches(entry)
        ? { ...entry, state, resolvedAt: now, resolution: resolutionLabel(resolution, state) }
        : entry
    )
  }
}

/** The requirement was met. Looking at a request is not meeting it; only its source can say so. */
export function resolveHumanAttention<T extends AttentionHost>(
  set: T,
  requestId: string,
  resolution: string,
  now: number
): T {
  return settle(set, (entry) => entry.id === requestId, 'resolved', resolution, now)
}

/** Whether the run still has the outcome, revision, plan version and attempt a request is about. */
export function isValidHumanAttention(
  set: AttentionHost,
  request: HumanAttentionRequest,
  planVersion = 1
): boolean {
  const outcome = set.outcomes.find((entry) => entry.id === request.scope.outcomeId)
  if (!outcome || outcome.revision !== request.scope.outcomeRevision) {
    return false
  }
  if (outcome.status === 'satisfied') {
    return false
  }
  if ((request.scope.planVersion ?? 1) < planVersion) {
    return false
  }
  if (!request.scope.attemptId) {
    return true
  }
  const attempt = set.attempts.find((entry) => entry.id === request.scope.attemptId)
  return Boolean(attempt && !['completed', 'superseded', 'retryable'].includes(attempt.state))
}

/** The only requests that may interrupt anyone: open AND still about the run as it is now. */
export function openHumanAttentionRequests(
  set: AttentionHost,
  planVersion = 1
): HumanAttentionRequest[] {
  return (set.attention ?? []).filter(
    (entry) => entry.state === 'open' && isValidHumanAttention(set, entry, planVersion)
  )
}

/**
 * The reconciler's pass: a request whose requirement is no longer asked for (`keep` does not list
 * it) was met, and one that no longer describes this run is withdrawn. Nothing else closes one.
 */
export function reconcileHumanAttention<T extends AttentionHost>(
  set: T,
  keep: ReadonlySet<string>,
  now: number,
  planVersion = 1
): T {
  const stale = settle(
    set,
    (entry) => !isValidHumanAttention(set, entry, planVersion),
    'withdrawn',
    'The run moved on.',
    now
  )
  return settle(stale, (entry) => !keep.has(entry.id), 'resolved', 'The requirement was met.', now)
}

/** Requests the host has not announced yet; announcing stamps them, exactly once. */
export function unannouncedHumanAttention(
  set: AttentionHost,
  planVersion = 1
): HumanAttentionRequest[] {
  return openHumanAttentionRequests(set, planVersion).filter(
    (entry) => entry.notifiedAt === undefined && entry.recipient.type === 'owner'
  )
}

export function markHumanAttentionAnnounced<T extends AttentionHost>(
  set: T,
  ids: readonly string[],
  now: number
): T {
  const due = (entry: HumanAttentionRequest): boolean =>
    ids.includes(entry.id) && entry.notifiedAt === undefined
  // Nothing left to stamp: the same object back, so a caller that saves on change saves nothing.
  if (!set.attention?.some(due)) {
    return set
  }
  return {
    ...set,
    attention: set.attention.map((entry) => (due(entry) ? { ...entry, notifiedAt: now } : entry))
  }
}
