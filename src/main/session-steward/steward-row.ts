/**
 * The steward's one move for one observed session (Phase 2, §3–4). Working: report silence.
 * Waiting for a yes: press Yes on a safe single step JEV reads as inside the request. Idle: a
 * blank session is closed; otherwise JEV's doneness reading decides between a nudge (work left),
 * a Tier 2 archive (finished) and a two-line "are you done?" question (unclear). Exited: blank,
 * else Tier 2. Unknown: the blank rule only. Switches are read each time.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import { SESSION_HUNG_AFTER_MS } from '../session-manage/session-manage-control'
import type { ObservedSession } from '../session-manage/session-manage-observe'
import { STEWARD_NUDGES_TOTAL } from './steward-caps'
import { STEWARD_ADVANCE_PASS, stewardDonenessVerdict } from './steward-jev'
import type { StewardPassDeps, StewardPassMemory } from './steward-pass'
import { isStewardLimitRefusal } from './steward-prompt-budget'
import { stewardTier2Step } from './steward-row-archive'
import { stewardEmptySessionStep } from './steward-row-empty'
import { stewardRemoteBlankStep } from './steward-remote-blank'
import { parseExecutionHostId } from '../../shared/execution-host'
import {
  message,
  none,
  note,
  stall,
  target,
  type StewardRow,
  type StewardRowOutcome
} from './steward-row-context'
import {
  STEWARD_NUDGE_TEXT,
  STEWARD_UNCLEAR_QUESTION,
  stewardAskDue,
  stewardNudgeDue,
  stewardSafeYesPick,
  stewardSilentMinutes,
  stewardStalledHolds
} from './steward-rules'
import { stewardFeatureMode, stewardFeatureOn } from './steward-switches'

export type { StewardRowAction, StewardRowOutcome } from './steward-row-context'

const SILENT_RECHECK_MS = 5 * 60_000

async function silentStep(ctx: StewardRow): Promise<StewardRowOutcome> {
  const lastOutputAt = ctx.entry.terminal ? await ctx.deps.lastOutputAt(ctx.entry.terminal) : null
  const minutes = stewardSilentMinutes(lastOutputAt, ctx.now)
  if (minutes === null || lastOutputAt === null) {
    ctx.memory.silent.delete(ctx.paneKey)
    return none(ctx, lastOutputAt === null ? undefined : lastOutputAt + SESSION_HUNG_AFTER_MS)
  }
  const known = ctx.memory.silent.get(ctx.paneKey)
  ctx.memory.silent.set(ctx.paneKey, { title: ctx.entry.title, since: lastOutputAt, minutes })
  if (known?.since === lastOutputAt) {
    return { paneKey: ctx.paneKey, action: 'silent', recheckAt: ctx.now + SILENT_RECHECK_MS }
  }
  const outcome = await note(
    ctx,
    'silent',
    `“${ctx.entry.title}” is working but has printed nothing for ${minutes} min; a restart may help. The steward never restarts it.`
  )
  return { ...outcome, recheckAt: ctx.now + SILENT_RECHECK_MS }
}

async function safeYesStep(
  ctx: StewardRow,
  source: ConversationSource
): Promise<StewardRowOutcome> {
  const mode = stewardFeatureMode('safeYes')
  if (mode === 'off' || !ctx.turnKey) {
    return none(ctx)
  }
  const own = await ctx.deps.readOwnSteps(source)
  if (!own.set || own.set.turnKey !== ctx.turnKey) {
    return none(ctx)
  }
  const pick = stewardSafeYesPick(own)
  const title = `“${ctx.entry.title}”`
  if (!pick.ok) {
    return note(ctx, 'refused', `Left ${title} for the person: ${pick.reason}.`, true)
  }
  // Why on without JEV: with it off the plan keeps safe Yes running on its mechanical checks alone.
  const jevOff = ctx.deps.jev.offReason()
  let basis = `mechanical checks only: ${jevOff}`
  if (!jevOff) {
    const goal = await ctx.deps.jev.goal(source)
    const score = goal
      ? await ctx.deps.jev.advances({ turnKey: ctx.turnKey, goal, step: pick.step })
      : null
    // Why wait: while JEV is on its gate holds, and a missing reading is asked for again later.
    if (score === null) {
      return none(ctx)
    }
    if (score < STEWARD_ADVANCE_PASS) {
      return note(
        ctx,
        'refused',
        `Left ${title} for the person: JEV scored its step “${pick.step.title}” ${score.toFixed(1)} of 4 against the request.`,
        true
      )
    }
    basis = `JEV scored it ${score.toFixed(1)} of 4 against the request`
  }
  if (mode === 'shadow') {
    return note(
      ctx,
      'would-yes',
      `Would have said yes to “${pick.step.title}” in ${title} (${basis}).`,
      true
    )
  }
  try {
    const summary = await ctx.deps.act.yes(target(ctx, source))
    return await note(ctx, 'yes', `${summary} (${basis})`)
  } catch (error) {
    return note(ctx, 'refused', `Did not say yes to ${title}: ${message(error)}`, true)
  }
}

async function nudgeStep(ctx: StewardRow, source: ConversationSource): Promise<StewardRowOutcome> {
  const state = ctx.deps.store.session(ctx.paneKey)
  if (!stewardFeatureOn('nudges') || stewardStalledHolds(state?.stalled, ctx.turnKey)) {
    return none(ctx)
  }
  const due = stewardNudgeDue(state?.nudge, ctx.entry.lastActivityAt, ctx.now)
  if (due.kind === 'never') {
    return stall(ctx, `nudged ${STEWARD_NUDGES_TOTAL} times and it still has work left.`)
  }
  if (due.kind === 'later') {
    return none(ctx, due.at)
  }
  try {
    return await note(
      ctx,
      'nudge',
      await ctx.deps.act.nudge(target(ctx, source), STEWARD_NUDGE_TEXT)
    )
  } catch (error) {
    // Why Stalled: a refused nudge is exactly what the rules could not move; a limit is not.
    return isStewardLimitRefusal(message(error))
      ? note(ctx, 'refused', `Did not nudge “${ctx.entry.title}”: ${message(error)}`, true)
      : stall(ctx, message(error))
  }
}

async function askStep(ctx: StewardRow, source: ConversationSource): Promise<StewardRowOutcome> {
  if (!stewardFeatureOn('nudges')) {
    return none(ctx)
  }
  const due = stewardAskDue(
    ctx.deps.store.session(ctx.paneKey)?.ask,
    ctx.entry.lastActivityAt,
    ctx.now
  )
  if (due.kind !== 'now') {
    return none(ctx, due.kind === 'later' ? due.at : undefined)
  }
  try {
    const summary = await ctx.deps.act.ask(target(ctx, source), STEWARD_UNCLEAR_QUESTION)
    return await note(ctx, 'ask', summary)
  } catch (error) {
    return note(ctx, 'refused', `Did not ask “${ctx.entry.title}”: ${message(error)}`, true)
  }
}

async function idleStep(ctx: StewardRow, source: ConversationSource, reply: string | null) {
  if (!ctx.turnKey || !reply || ctx.deps.jev.offReason()) {
    return none(ctx)
  }
  const doneness = await ctx.deps.jev.doneness({ source, turnKey: ctx.turnKey, reply })
  if (!doneness) {
    return none(ctx)
  }
  const verdict = stewardDonenessVerdict(doneness)
  if (verdict === 'finished') {
    return stewardTier2Step(ctx)
  }
  ctx.memory.leftovers.delete(ctx.paneKey)
  return verdict === 'work-left' ? nudgeStep(ctx, source) : askStep(ctx, source)
}

export async function judgeStewardRow(
  deps: StewardPassDeps,
  memory: StewardPassMemory,
  row: SessionManageSidebarRow,
  session: ObservedSession,
  entry: SessionManageEntry
): Promise<StewardRowOutcome> {
  if (parseExecutionHostId(row.hostId)?.kind === 'ssh') {
    // Why before any read: only the blank rules reach a session an SSH host runs.
    const remote: StewardRow = {
      deps,
      memory,
      row,
      session,
      entry,
      paneKey: row.paneKey!,
      turnKey: null,
      now: deps.now()
    }
    return (await stewardRemoteBlankStep(remote)) ?? none(remote)
  }
  const { source } = session
  const turn = source ? await deps.latestTurn(source) : null
  const ctx: StewardRow = {
    deps,
    memory,
    row,
    session,
    entry,
    paneKey: row.paneKey!,
    turnKey: turn?.known ? turn.turnKey : null,
    now: deps.now()
  }
  const stalled = deps.store.session(ctx.paneKey)?.stalled
  if (stalled && !stewardStalledHolds(stalled, ctx.turnKey)) {
    await deps.store.transact((data) => {
      delete data.sessions[ctx.paneKey]?.stalled
    })
  }
  if (entry.state !== 'working') {
    memory.silent.delete(ctx.paneKey)
  }
  if (entry.verdict === 'exited') {
    return (await stewardEmptySessionStep(ctx)) ?? stewardTier2Step(ctx)
  }
  if (!source) {
    return none(ctx)
  }
  switch (entry.state) {
    case 'working':
      return silentStep(ctx)
    case 'waiting-for-yes':
      return safeYesStep(ctx, source)
    case 'idle':
      return (await stewardEmptySessionStep(ctx)) ?? idleStep(ctx, source, turn?.text ?? null)
    // Why: an agent at its fresh start may show no idle marker yet; only the blank rule reads it.
    case 'unknown':
      return (await stewardEmptySessionStep(ctx)) ?? none(ctx)
    // Why nothing: a queue, the person's own question or a limit already holds it.
    case 'queued':
    case 'awaiting-user':
    case 'provider-limited':
    case 'exited':
      return none(ctx)
  }
}
