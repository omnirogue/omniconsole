/**
 * Continues, once, a turn a login failure cut off. When that account's login works again, the same
 * conversation gets one continue prompt: in its own pane when that is live, else after reopening
 * that conversation in place (same account, folder and model). Never a fresh session, never
 * another account; a protection refusal settles the record as held and is never bypassed.
 *
 * Exactly once: the prompt's queue id is derived from the failure, a queue entry already there is
 * adopted rather than queued again, and a record left `reopening` or `queued` by a restart is only
 * followed up, never sent blindly.
 */

import type { AccountLoginReadiness } from './account-login-ready'
import { loginResumePromptId, loginResumeText } from './login-killed-turns'
import {
  isLoginKilledTurnSettled,
  type LoginKilledHeldReason,
  type LoginKilledTurn,
  type LoginKilledTurnStore
} from './login-killed-turns-store'

export const LOGIN_RESUME_TICK_MS = 60_000
/** A failure older than this is no longer continued. */
export const LOGIN_RESUME_MAX_AGE_MS = 24 * 60 * 60_000
/** How long a reopened conversation has to show its agent before the record is held. */
const REOPEN_WAIT_MS = 5 * 60_000
/** A delivered prompt counts as taken up after this even when no new turn was seen. */
const DELIVERED_SETTLE_MS = 5 * 60_000
/** Why bounded: a login that keeps failing right after it reads ready must not loop. */
const RESUMES_PER_DAY = 2

export type LoginResumePane = { paneKey: string; worktreeId: string }
export type LoginResumeHolder =
  | { kind: 'live'; pane: LoginResumePane }
  | { kind: 'none' }
  | { kind: 'blocked'; reason: string }
/** The pane's current hook state: when it began, and whether it is a session boundary. */
export type LoginResumeTurn = { state: string; startedAt: number; boundary: boolean }
export type LoginResumeQueueState =
  | 'queued'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'failed-unsent'
  | 'missing'

/** A resume that refused and started nothing. */
export class LoginResumeRefusal extends Error {
  constructor(
    readonly reason: LoginKilledHeldReason,
    message: string
  ) {
    super(message)
  }
}

export type LoginResumeDeps = {
  store: Pick<LoginKilledTurnStore, 'list' | 'update'>
  loginReady(record: LoginKilledTurn): Promise<AccountLoginReadiness>
  /** The live pane holding this conversation (its reopened pane first, then its own). */
  findPane(record: LoginKilledTurn): Promise<LoginResumeHolder>
  turn(pane: LoginResumePane): LoginResumeTurn | null
  windowAttached(): boolean
  /** Reopens the same conversation; throws `LoginResumeRefusal` when it refused. */
  resume(record: LoginKilledTurn): Promise<LoginResumePane>
  /** Queues the prompt for the proven agent; false when the agent cannot be proven. */
  enqueue(pane: LoginResumePane, id: string, text: string): Promise<boolean>
  queueState(pane: LoginResumePane, id: string): LoginResumeQueueState
  /** Records failures no hook reports (Codex rollouts). */
  scan?(): Promise<void>
  now(): number
  timeZone?: string
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Any hook state entered after `since`, other than a session boundary, is newer work. */
const newerWork = (turn: LoginResumeTurn | null, since: number): boolean =>
  turn !== null && turn.startedAt > since && !turn.boundary

export async function loginResumePass(deps: LoginResumeDeps): Promise<void> {
  try {
    await deps.scan?.()
  } catch {
    /* A failed scan only delays recording; the next pass reads again. */
  }
  const open = deps.store.list().filter((record) => !isLoginKilledTurnSettled(record))
  const newest = new Map(open.map((record) => [record.ref, record]))
  for (const record of open) {
    try {
      if (record.state === 'pending' && newest.get(record.ref) !== record) {
        deps.store.update(record.id, {
          state: 'superseded',
          detail: 'a later login failure in the same conversation replaced it'
        })
        continue
      }
      await step(deps, record)
    } catch (error) {
      hold(deps, record, 'error', messageOf(error))
    }
  }
}

function hold(
  deps: LoginResumeDeps,
  record: LoginKilledTurn,
  heldReason: LoginKilledHeldReason,
  detail: string
): void {
  deps.store.update(record.id, { state: 'held', heldReason, detail: detail.slice(0, 300) })
}

/** Keeps a record pending with what it waits for; written only when that changed. */
function wait(
  deps: LoginResumeDeps,
  record: LoginKilledTurn,
  heldReason: LoginKilledHeldReason,
  detail: string
): void {
  if (record.heldReason !== heldReason || record.detail !== detail) {
    deps.store.update(record.id, { heldReason, detail })
  }
}

async function step(deps: LoginResumeDeps, record: LoginKilledTurn): Promise<void> {
  if (record.state === 'queued') {
    return followQueued(deps, record)
  }
  if (record.state === 'reopening') {
    return followReopening(deps, record)
  }
  const now = deps.now()
  if (now - record.killedAt > LOGIN_RESUME_MAX_AGE_MS) {
    return hold(deps, record, 'login_failed', 'the login did not work again within a day')
  }
  const resumedToday = deps.store
    .list()
    .filter(
      (other) =>
        other.ref === record.ref &&
        other.state === 'resumed' &&
        now - (other.settledAt ?? other.updatedAt) < LOGIN_RESUME_MAX_AGE_MS
    ).length
  if (resumedToday >= RESUMES_PER_DAY) {
    return hold(
      deps,
      record,
      'login_failed',
      `it was already continued ${resumedToday} times today after a login failure`
    )
  }
  const login = await deps.loginReady(record)
  if (!login.ready) {
    return wait(deps, record, login.held, login.reason)
  }
  const holder = await deps.findPane(record)
  if (holder.kind === 'blocked') {
    return wait(deps, record, 'unverifiable', holder.reason)
  }
  if (holder.kind === 'live') {
    if (newerWork(deps.turn(holder.pane), record.killedAt)) {
      deps.store.update(record.id, { state: 'superseded', detail: 'newer work ran in it' })
      return
    }
    const queued = await queuePrompt(deps, record, holder.pane)
    if (!queued) {
      wait(
        deps,
        record,
        'unverifiable',
        `its agent in pane ${holder.pane.paneKey} cannot be proven`
      )
    }
    return
  }
  if (!deps.windowAttached()) {
    return wait(
      deps,
      record,
      'no_window',
      'it reopens when the OmniConsole window is open on this computer'
    )
  }
  if (deps.store.list().some((other) => other.state === 'reopening')) {
    // Why one at a time: the next conversation reopens after this one has reported in.
    return
  }
  const reopening = deps.store.update(record.id, {
    state: 'reopening',
    reopenedAt: now,
    heldReason: undefined,
    detail: undefined
  })
  if (!reopening) {
    return
  }
  let pane: LoginResumePane
  try {
    pane = await deps.resume(reopening)
  } catch (error) {
    // Something may have started unless it refused: a resume is never retried automatically.
    const reason = error instanceof LoginResumeRefusal ? error.reason : 'unverifiable'
    return hold(deps, reopening, reason, messageOf(error))
  }
  const reopened = deps.store.update(record.id, { target: pane })
  if (reopened) {
    await followReopening(deps, reopened)
  }
}

async function followReopening(deps: LoginResumeDeps, record: LoginKilledTurn): Promise<void> {
  const since = record.reopenedAt ?? record.updatedAt
  const timedOut = deps.now() - since > REOPEN_WAIT_MS
  const holder = await deps.findPane(record)
  if (holder.kind === 'live') {
    if (newerWork(deps.turn(holder.pane), since)) {
      deps.store.update(record.id, { state: 'superseded', detail: 'newer work ran in it' })
      return
    }
    if (!record.target) {
      deps.store.update(record.id, { target: holder.pane })
    }
    if (await queuePrompt(deps, record, holder.pane)) {
      return
    }
  }
  if (timedOut) {
    hold(
      deps,
      record,
      'unverifiable',
      record.target
        ? `the reopened conversation never showed its agent in pane ${record.target.paneKey}`
        : 'OmniConsole restarted while reopening it, so it is not reopened a second time'
    )
  }
}

/** Adopts an entry already queued under this failure's id, else queues it; true once queued. */
async function queuePrompt(
  deps: LoginResumeDeps,
  record: LoginKilledTurn,
  pane: LoginResumePane
): Promise<boolean> {
  const id = loginResumePromptId(record)
  if (deps.queueState(pane, id) === 'missing') {
    if (!(await deps.enqueue(pane, id, loginResumeText(record.killedAt, deps.timeZone)))) {
      return false
    }
  }
  deps.store.update(record.id, {
    state: 'queued',
    target: pane,
    promptId: id,
    heldReason: undefined,
    detail: undefined
  })
  return true
}

function followQueued(deps: LoginResumeDeps, record: LoginKilledTurn): void {
  const pane = {
    paneKey: record.target?.paneKey ?? record.paneKey,
    worktreeId: record.target?.worktreeId ?? record.worktreeId
  }
  const state = deps.queueState(pane, record.promptId ?? loginResumePromptId(record))
  if (state === 'queued' || state === 'sending') {
    return
  }
  if (state === 'delivered') {
    const now = deps.now()
    const deliveredAt = record.deliveredAt ?? now
    if (record.deliveredAt === undefined) {
      deps.store.update(record.id, { deliveredAt })
    }
    if (newerWork(deps.turn(pane), record.killedAt) || now - deliveredAt >= DELIVERED_SETTLE_MS) {
      deps.store.update(record.id, { state: 'resumed' })
    }
    return
  }
  if (state === 'failed-unsent') {
    return hold(deps, record, 'error', 'the continue prompt was not sent')
  }
  hold(
    deps,
    record,
    'unverifiable',
    state === 'failed'
      ? 'whether the continue prompt reached the agent cannot be confirmed'
      : 'the continue prompt is no longer queued, so it is not sent a second time'
  )
}

/** Runs a pass every minute (not overlapping); returns the stop. */
export function startLoginResumeTimer(
  deps: LoginResumeDeps,
  everyMs = LOGIN_RESUME_TICK_MS
): () => void {
  let running = false
  const tick = (): void => {
    if (running) {
      return
    }
    running = true
    void loginResumePass(deps)
      .catch((error: unknown) => console.warn('[login-resume] pass failed', error))
      .finally(() => {
        running = false
      })
  }
  const timer = setInterval(tick, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
