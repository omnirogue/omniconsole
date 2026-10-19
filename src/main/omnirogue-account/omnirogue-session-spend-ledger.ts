const WARNING_RATIO = 0.8
const DEFAULT_MAX_SESSIONS = 500
const MAX_SETTLED_IDS = 1_000
const MAX_ID_LENGTH = 512
const CREDIT_SCALE = 1_000_000
const UNKNOWN_MODEL = 'unknown'

export type OmniRogueSpendLevel = 'ok' | 'warning' | 'exceeded'

export type OmniRogueSpendGuard = {
  allowed: boolean
  level: OmniRogueSpendLevel
  remainingCredits: number | null
  shortfallCredits: number
}

export type OmniRogueSessionSpendSnapshot = {
  sessionId: string
  spentCredits: number
  reservedCredits: number
  budgetCredits: number | null
  requestCount: number
  creditsByModel: Record<string, number>
  guard: OmniRogueSpendGuard
  updatedAt: number | null
}

export type OmniRogueSpendRejection =
  | 'invalid_request'
  | 'invalid_credits'
  | 'duplicate_request'
  | 'over_budget'
  | 'unknown_request'

export type OmniRogueSpendResult =
  | { ok: true; snapshot: OmniRogueSessionSpendSnapshot }
  | { ok: false; reason: OmniRogueSpendRejection; snapshot: OmniRogueSessionSpendSnapshot | null }

export type OmniRogueSessionSpendLedgerOptions = {
  now?: () => number
  maxSessions?: number
}

type SessionSpendState = {
  spentCredits: number
  budgetCredits: number | null
  requestCount: number
  pending: Map<string, { credits: number; model: string }>
  settledIds: Set<string>
  creditsByModel: Map<string, number>
  updatedAt: number | null
}

function roundCredits(value: number): number {
  return Math.round(value * CREDIT_SCALE) / CREDIT_SCALE
}

function isValidCredits(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function normalizeId(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 && trimmed.length <= MAX_ID_LENGTH ? trimmed : null
}

function createState(): SessionSpendState {
  return {
    spentCredits: 0,
    budgetCredits: null,
    requestCount: 0,
    pending: new Map(),
    settledIds: new Set(),
    creditsByModel: new Map(),
    updatedAt: null
  }
}

function sumReserved(state: SessionSpendState): number {
  let total = 0
  for (const reservation of state.pending.values()) {
    total += reservation.credits
  }
  return roundCredits(total)
}

export class OmniRogueSessionSpendLedger {
  private readonly sessions = new Map<string, SessionSpendState>()
  private readonly listeners = new Set<(snapshot: OmniRogueSessionSpendSnapshot) => void>()
  private readonly now: () => number
  private readonly maxSessions: number

  constructor(options: OmniRogueSessionSpendLedgerOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxSessions = Math.max(1, Math.floor(options.maxSessions ?? DEFAULT_MAX_SESSIONS))
  }

  setBudget(sessionId: string, budgetCredits: number | null): OmniRogueSpendResult {
    const id = normalizeId(sessionId)
    if (!id) {
      return this.reject('invalid_request', null)
    }
    if (budgetCredits !== null && !isValidCredits(budgetCredits)) {
      return this.reject('invalid_credits', id)
    }
    const state = this.touch(id)
    state.budgetCredits = budgetCredits === null ? null : roundCredits(budgetCredits)
    return this.commit(id, state)
  }

  check(sessionId: string, estimatedCredits = 0): OmniRogueSpendGuard {
    const id = normalizeId(sessionId)
    const state = id ? this.sessions.get(id) : undefined
    const valid = isValidCredits(estimatedCredits)
    const guard = this.guardFor(state, valid ? estimatedCredits : 0)
    return valid ? guard : { ...guard, allowed: false }
  }

  reserve(sessionId: string, requestId: string, credits: number, model?: string) {
    const resolved = this.resolve(sessionId, requestId, credits)
    if ('ok' in resolved) {
      return resolved
    }
    const { id, request } = resolved
    const existing = this.sessions.get(id)
    if (existing?.pending.has(request)) {
      return this.reject('duplicate_request', id)
    }
    if (existing && !this.guardFor(existing, credits).allowed) {
      return this.reject('over_budget', id)
    }
    const state = this.touch(id)
    const modelKey = model?.trim() || UNKNOWN_MODEL
    state.pending.set(request, { credits: roundCredits(credits), model: modelKey })
    return this.commit(id, state)
  }

  settle(sessionId: string, requestId: string, credits: number, model?: string) {
    const resolved = this.resolve(sessionId, requestId, credits)
    if ('ok' in resolved) {
      return resolved
    }
    const { id, request } = resolved
    const state = this.touch(id)
    const reservation = state.pending.get(request)
    state.pending.delete(request)
    const amount = roundCredits(credits)
    const modelKey = model?.trim() || reservation?.model || UNKNOWN_MODEL
    state.spentCredits = roundCredits(state.spentCredits + amount)
    state.requestCount += 1
    const modelTotal = (state.creditsByModel.get(modelKey) ?? 0) + amount
    state.creditsByModel.set(modelKey, roundCredits(modelTotal))
    state.settledIds.add(request)
    const oldestSettled = state.settledIds.values().next().value
    if (state.settledIds.size > MAX_SETTLED_IDS && oldestSettled !== undefined) {
      state.settledIds.delete(oldestSettled)
    }
    return this.commit(id, state)
  }

  release(sessionId: string, requestId: string): OmniRogueSpendResult {
    const resolved = this.resolve(sessionId, requestId, 0)
    if ('ok' in resolved) {
      return resolved
    }
    const { id, request } = resolved
    if (!this.sessions.get(id)?.pending.has(request)) {
      return this.reject('unknown_request', id)
    }
    const state = this.touch(id)
    state.pending.delete(request)
    return this.commit(id, state)
  }

  clear(sessionId: string): boolean {
    const id = normalizeId(sessionId)
    if (!id || !this.sessions.delete(id)) {
      return false
    }
    this.emit(this.toSnapshot(id, createState()))
    return true
  }

  snapshot(sessionId: string): OmniRogueSessionSpendSnapshot {
    const id = normalizeId(sessionId) ?? ''
    return this.toSnapshot(id, this.sessions.get(id) ?? createState())
  }

  list(): OmniRogueSessionSpendSnapshot[] {
    return Array.from(this.sessions, ([id, state]) => this.toSnapshot(id, state)).sort(
      (a, b) => b.spentCredits - a.spentCredits || a.sessionId.localeCompare(b.sessionId)
    )
  }

  onChange(listener: (snapshot: OmniRogueSessionSpendSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private resolve(
    sessionId: string,
    requestId: string,
    credits: number
  ): { id: string; request: string } | OmniRogueSpendResult {
    const id = normalizeId(sessionId)
    const request = normalizeId(requestId)
    if (!id || !request) {
      return this.reject('invalid_request', id)
    }
    if (!isValidCredits(credits)) {
      return this.reject('invalid_credits', id)
    }
    if (this.sessions.get(id)?.settledIds.has(request)) {
      return this.reject('duplicate_request', id)
    }
    return { id, request }
  }

  private reject(reason: OmniRogueSpendRejection, sessionId: string | null): OmniRogueSpendResult {
    const state = sessionId ? this.sessions.get(sessionId) : undefined
    const snapshot = sessionId && state ? this.toSnapshot(sessionId, state) : null
    return { ok: false, reason, snapshot }
  }

  private touch(sessionId: string): SessionSpendState {
    const state = this.sessions.get(sessionId) ?? createState()
    this.sessions.delete(sessionId)
    this.sessions.set(sessionId, state)
    state.updatedAt = this.now()
    for (const [id, candidate] of this.sessions) {
      if (this.sessions.size <= this.maxSessions) {
        break
      }
      if (id !== sessionId && candidate.pending.size === 0) {
        this.sessions.delete(id)
      }
    }
    return state
  }

  private commit(sessionId: string, state: SessionSpendState): OmniRogueSpendResult {
    const snapshot = this.toSnapshot(sessionId, state)
    this.emit(snapshot)
    return { ok: true, snapshot }
  }

  private emit(snapshot: OmniRogueSessionSpendSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // A failing subscriber must not break spend accounting.
      }
    }
  }

  private guardFor(state: SessionSpendState | undefined, additional: number): OmniRogueSpendGuard {
    const budget = state?.budgetCredits ?? null
    if (!state || budget === null) {
      return { allowed: true, level: 'ok', remainingCredits: null, shortfallCredits: 0 }
    }
    const committed = roundCredits(state.spentCredits + sumReserved(state))
    const projected = roundCredits(committed + additional)
    const shortfallCredits = roundCredits(Math.max(0, projected - budget))
    let level: OmniRogueSpendLevel = 'ok'
    if (projected > budget) {
      level = 'exceeded'
    } else if (projected >= budget * WARNING_RATIO) {
      level = 'warning'
    }
    return {
      allowed: shortfallCredits === 0,
      level,
      remainingCredits: roundCredits(Math.max(0, budget - committed)),
      shortfallCredits
    }
  }

  private toSnapshot(sessionId: string, state: SessionSpendState): OmniRogueSessionSpendSnapshot {
    return {
      sessionId,
      spentCredits: state.spentCredits,
      reservedCredits: sumReserved(state),
      budgetCredits: state.budgetCredits,
      requestCount: state.requestCount,
      creditsByModel: Object.fromEntries(state.creditsByModel),
      guard: this.guardFor(state, 0),
      updatedAt: state.updatedAt
    }
  }
}

const sharedSpendLedger = new OmniRogueSessionSpendLedger()

export function getSharedOmniRogueSessionSpendLedger(): OmniRogueSessionSpendLedger {
  return sharedSpendLedger
}
