import { randomUUID } from 'node:crypto'
import {
  isSessionChainAgentStep,
  normalizeSessionChain,
  type SessionChain
} from '../../shared/session-chain-types'
import {
  markHumanAttentionAnnounced,
  type HumanAttentionRequest
} from '../../shared/session-human-attention'
import {
  sealSessionRunCompletion,
  type SessionRunDisposition
} from '../../shared/session-run-completion'
import { readSessionRun, type SessionRunReading } from '../../shared/session-run-lifecycle'
import { reconcileSessionOutcomeSet } from '../../shared/session-outcome-revise'
import type { SessionOutcomeSet } from '../../shared/session-outcome-types'
import {
  SESSION_RUN_SUPERSEDED_MAX,
  type SessionRunHeldContinuation
} from '../../shared/session-run-held-continuation'
import type { UpNextHeldContinuation } from './up-next-held-gates'
import { canonicalJson } from '../../shared/decision-contracts/decision-calibration-summary'

export type SettledSessionOutcomeChain = {
  chain: SessionChain
  /** Requests this write announces: stamped in it, so no later write announces them again. */
  announce: HumanAttentionRequest[]
}

/**
 * The record the single terminal writer persists, read from the one lifecycle policy
 * (`docs/reference/session-run-lifecycle.md`): the state a run is in, the seal on a run whose
 * required work is proven, and the requests that are about to be announced.
 */
export function settleSessionOutcomeChain(input: {
  chain: SessionChain
  /** What is persisted now; a sealed record decides everything about the write. */
  current: SessionChain | undefined
  now: number
  operationId?: () => string
  /** This run's own reviews still out, and work held behind one (`up-next-held-gates.ts`). */
  held?: UpNextHeldContinuation | null
}): SettledSessionOutcomeChain {
  const { chain, current, now } = input
  if (current?.outcomeSet?.completion) {
    return { chain: keepSealedSessionOutcomeChain(current, chain), announce: [] }
  }
  const { set, run } = withHeldContinuation(
    carryAnnouncedAttention(chain.outcomeSet!, current?.outcomeSet),
    current?.outcomeSet?.heldContinuation,
    input.held,
    { now, planVersion: chain.planVersion ?? 1 }
  )
  // A proven stage with required stages still ahead of it is progress, not completion.
  if (run.phase === 'completed' && chain.currentIndex >= chain.steps.length) {
    return {
      chain: {
        ...chain,
        auto: true,
        state: 'done',
        error: null,
        // Why reconciled: a sealed set is never reconciled again, so a stale `pending` would freeze.
        outcomeSet: sealSessionRunCompletion(reconcileSessionOutcomeSet(set), {
          now,
          operationId: (input.operationId ?? randomUUID)(),
          ...(chain.planVersion ? { planVersion: chain.planVersion } : {})
        })
      },
      announce: []
    }
  }
  // Only valid open requests addressed to the owner are ever read here: a failed, waiting or
  // recovering run has none, so it announces nothing.
  const announce = run.attention.filter((entry) => entry.notifiedAt === undefined)
  // Why `error` is left out when there is nothing to say: the store drops an empty one, so writing
  // `null` made every idle pass differ from the record and flush the whole profile again.
  const { error: _previous, ...record } = chain
  const diagnostics = run.reasons.join('\n')
  return {
    chain: {
      ...record,
      auto: true,
      // A cancelled run is finished business (the tick skips it); no reading makes it wait again.
      state:
        chain.state === 'cancelled' ? 'cancelled' : run.phase === 'failed' ? 'failed' : 'waiting',
      ...(diagnostics ? { error: diagnostics } : {}),
      outcomeSet: markHumanAttentionAnnounced(
        set,
        announce.map((entry) => entry.id),
        now
      )
    },
    announce
  }
}

/**
 * The stamp that keeps a run its own reviews hold open. Which gates it names, when the run was
 * otherwise complete and the last refusal are re-derived on every write (`up-next-held-gates.ts`);
 * the record of each "needs changes" reply is kept by union, so a writer holding an older snapshot
 * can never lose one. It is gone the moment no review of this run holds it.
 */
function withHeldContinuation(
  offered: SessionOutcomeSet,
  recorded: SessionRunHeldContinuation | undefined,
  held: UpNextHeldContinuation | null | undefined,
  options: { now: number; planVersion: number }
): { set: SessionOutcomeSet; run: SessionRunReading } {
  const { heldContinuation: carried, ...set } = offered
  const run = readSessionRun(set, options)
  if (!held?.reviewStepIds.length) {
    return { set, run }
  }
  const fixes = new Map((recorded?.fixes ?? []).map((fix) => [fix.receipt, fix]))
  for (const fix of carried?.fixes ?? []) {
    fixes.set(fix.receipt, { ...fixes.get(fix.receipt), ...fix })
  }
  // Retired answers are kept by union too: an older snapshot must not make an old OK count again.
  const superseded = [
    ...new Set([...(recorded?.superseded ?? []), ...(carried?.superseded ?? [])])
  ].slice(-SESSION_RUN_SUPERSEDED_MAX)
  const stamped: SessionOutcomeSet = {
    ...set,
    heldContinuation: {
      reviewStepIds: [...held.reviewStepIds],
      ...(run.phase === 'completed' ? { since: recorded?.since ?? options.now } : {}),
      ...(held.refused
        ? { refused: held.refused, refusedSince: held.refusedSince ?? options.now }
        : {}),
      ...(fixes.size ? { fixes: [...fixes.values()].slice(-64) } : {}),
      ...(superseded.length ? { superseded } : {})
    }
  }
  return { set: stamped, run: readSessionRun(stamped, options) }
}

/**
 * Whether a write would change nothing durable. Both sides are read the way the store reads them
 * (`normalizeSessionChain`: dropped empties, one key order), so a record that merely LOOKS different
 * in memory is not flushed; a record the normalizer refuses is never called unchanged.
 */
export function sameDurableSessionChain(
  current: SessionChain | undefined,
  offered: SessionChain
): boolean {
  if (!current) {
    return false
  }
  const recorded = durableForm(current)
  // Why first: an idle tick offers the record back unchanged, and the normalizer (a schema parse)
  // dominated each such save; a value equal to a normalizable record normalizes the same.
  if (recorded.normalizable && canonicalJson(offered) === recorded.canonical) {
    return true
  }
  const next = normalizeSessionChain(offered)
  return next !== null && recorded.normalized === JSON.stringify(next)
}

type DurableForm = { canonical: string; normalized: string; normalizable: boolean }

// Why identity: the store's snapshot records are deep-frozen and replaced on every write.
const durableForms = new WeakMap<SessionChain, DurableForm>()

function durableForm(current: SessionChain): DurableForm {
  const cached = durableForms.get(current)
  if (cached) {
    return cached
  }
  const normalized = normalizeSessionChain(current)
  const form = {
    canonical: canonicalJson(current),
    normalized: JSON.stringify(normalized ?? current),
    normalizable: normalized !== null
  }
  if (Object.isFrozen(current)) {
    durableForms.set(current, form)
  }
  return form
}

/**
 * A writer may still hold the set from before a request was announced. The durable stamp wins, so
 * its save cannot announce the same request a second time; a request that was settled and opened
 * AGAIN has a new `openedAt` and is announced as the new request it is.
 */
function carryAnnouncedAttention(
  set: SessionOutcomeSet,
  recorded: SessionOutcomeSet | undefined
): SessionOutcomeSet {
  const stamps = new Map(
    (recorded?.attention ?? []).flatMap((entry) =>
      entry.notifiedAt === undefined
        ? []
        : [[`${entry.id}:${entry.openedAt}`, entry.notifiedAt] as const]
    )
  )
  const stale = (entry: HumanAttentionRequest): boolean =>
    entry.notifiedAt === undefined && stamps.has(`${entry.id}:${entry.openedAt}`)
  if (!set.attention?.some(stale)) {
    return set
  }
  return {
    ...set,
    attention: set.attention.map((entry) =>
      stale(entry) ? { ...entry, notifiedAt: stamps.get(`${entry.id}:${entry.openedAt}`)! } : entry
    )
  }
}

/**
 * A sealed run is final. Whatever a writer offers — a late attempt, a stale snapshot, drifted
 * evidence, an unowned host — the persisted record stands. Two things of THIS seal may still move:
 * its disposition, forward only, and the delivery bookkeeping of prompts the person queued for a
 * stage's conversation, which is mail to an agent and no part of what was proven. Filing under a
 * card writes `taskRef` through its own door (`session-outcome-task-ref.ts`), which the
 * persistence fence admits.
 */
function keepSealedSessionOutcomeChain(current: SessionChain, offered: SessionChain): SessionChain {
  const sealed = current.outcomeSet!
  const sameSeal =
    JSON.stringify(offered.outcomeSet?.completion) === JSON.stringify(sealed.completion)
  const disposition = sameSeal
    ? laterSessionRunDisposition(sealed.disposition, offered.outcomeSet?.disposition)
    : sealed.disposition
  // Why `error` is left out, not nulled: the store drops a null error, so writing one would make
  // every late save of a sealed run look like a change and flush it again.
  const { error: _diagnostics, ...record } = current
  return {
    ...record,
    auto: true,
    // Why the prompts are taken: a delivery whose `sending` mark was dropped here would be read as
    // still queued on the next pass, and the same prompt would be sent to the agent again for ever.
    steps: sameSeal ? withOfferedStagePrompts(current.steps, offered.steps) : current.steps,
    state: 'done',
    outcomeSet: { ...sealed, ...(disposition ? { disposition } : {}) }
  }
}

function withOfferedStagePrompts(
  recorded: SessionChain['steps'],
  offered: SessionChain['steps']
): SessionChain['steps'] {
  return recorded.map((step) => {
    const next = offered.find((entry) => entry.id === step.id)
    if (
      !next ||
      !isSessionChainAgentStep(step) ||
      !isSessionChainAgentStep(next) ||
      JSON.stringify(next.prompts) === JSON.stringify(step.prompts)
    ) {
      return step
    }
    const { prompts: _recorded, ...rest } = step
    return next.prompts ? { ...rest, prompts: next.prompts } : rest
  })
}

function laterSessionRunDisposition(
  recorded: SessionRunDisposition | undefined,
  offered: SessionRunDisposition | undefined
): SessionRunDisposition | undefined {
  if (
    !recorded ||
    !offered ||
    offered.operationId !== recorded.operationId ||
    // Applied is the end of the operation: nothing reported later is about it any more.
    recorded.state === 'applied' ||
    offered.updatedAt < recorded.updatedAt
  ) {
    return recorded
  }
  return offered
}
