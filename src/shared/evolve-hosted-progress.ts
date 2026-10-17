/**
 * Live hosted Evolve progress, folded from omnisi-evolve-service's run event stream
 * (`GET /api/evolve/runs/:id/events`). Run completion still comes from polling the run.
 */
export type EvolveHostedProgressKind =
  | 'evaluated'
  | 'eliminated'
  | 'frontier'
  | 'promoted'
  | 'rolled_back'
  | 'budget'
  | 'lease'

export type EvolveHostedProgressEntry = {
  id: string
  at: string
  kind: EvolveHostedProgressKind
  candidateId?: string
  generation?: number
  score?: number
}

export type EvolveHostedProgress = {
  /** `stream` while the event stream is open; `polling` once it dropped or was refused. */
  transport: 'stream' | 'polling'
  /** Sent back as `Last-Event-ID` so a reconnect resumes instead of replaying. */
  lastEventId?: string
  updatedAt: string
  evaluated: number
  eliminated: number
  generation?: number
  best?: { candidateId?: string; score: number }
  recent: EvolveHostedProgressEntry[]
}

/** One `OutcomeEvent` as the service serializes it; unknown keys are dropped. */
export type EvolveHostedEvent = {
  id: string
  type: string
  candidateId?: string
  createdAt?: string
  payload: Record<string, unknown>
}

const MAX_RECENT = 12
const KIND_BY_TYPE: Record<string, EvolveHostedProgressKind> = {
  candidate_evaluated: 'evaluated',
  frontier_advanced: 'frontier',
  canary_promoted: 'promoted',
  canary_rolled_back: 'rolled_back',
  budget_exhausted: 'budget',
  lease_reclaimed: 'lease'
}
// Candidate statuses that take a candidate out of the run (knockout losers and rejects).
const ELIMINATED_STATUSES = new Set([
  'failed',
  'duplicate',
  'rejected',
  'eliminated',
  'tournament_eliminated'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The SSE `data:` JSON of one event, or undefined when it is not an `OutcomeEvent`. */
export function parseEvolveHostedEvent(
  data: unknown,
  fallback: { id?: string; type?: string }
): EvolveHostedEvent | undefined {
  if (!isRecord(data)) {
    return undefined
  }
  const id = text(data.id) ?? text(fallback.id)
  const type = text(data.event_type) ?? text(fallback.type)
  if (!id || !type) {
    return undefined
  }
  const payload = isRecord(data.payload) ? data.payload : {}
  return {
    id,
    type,
    candidateId: text(data.candidate_id) ?? text(payload.candidate_id),
    createdAt: text(data.created_at),
    payload
  }
}

export function emptyEvolveHostedProgress(
  at: string,
  transport: EvolveHostedProgress['transport']
): EvolveHostedProgress {
  return { transport, updatedAt: at, evaluated: 0, eliminated: 0, recent: [] }
}

/** Folds one event into the progress in place; unknown event types only move the cursor. */
export function applyEvolveHostedEvent(
  progress: EvolveHostedProgress,
  event: EvolveHostedEvent,
  at: string
): void {
  progress.lastEventId = event.id
  progress.updatedAt = at
  let kind = KIND_BY_TYPE[event.type]
  if (!kind) {
    return
  }
  const score = finite(event.payload.score)
  const generation = finite(event.payload.generation)
  if (kind === 'evaluated') {
    progress.evaluated += 1
    const status = text(event.payload.status)
    const failure = text(event.payload.failure_class)
    if ((status && ELIMINATED_STATUSES.has(status)) || failure === 'tournament_eliminated') {
      progress.eliminated += 1
      kind = 'eliminated'
    }
  }
  if (kind === 'frontier' && score !== undefined) {
    progress.best = { candidateId: event.candidateId, score }
  }
  if (generation !== undefined) {
    progress.generation = Math.max(progress.generation ?? 0, generation)
  }
  progress.recent.push({
    id: event.id,
    at: event.createdAt ?? at,
    kind,
    candidateId: event.candidateId,
    generation,
    score
  })
  if (progress.recent.length > MAX_RECENT) {
    progress.recent.splice(0, progress.recent.length - MAX_RECENT)
  }
}
