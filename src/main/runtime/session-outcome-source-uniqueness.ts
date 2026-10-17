import { createHash } from 'node:crypto'
import {
  sessionOutcomeDefinition,
  sessionOutcomeDefinitionSchema,
  type SessionOutcomeCommit
} from '../../shared/session-outcome-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import { SESSION_RUN_SEALED_ERROR } from '../../shared/session-run-sealed-revision'
import type { SessionChain } from '../../shared/session-chain-types'

/** Sealed success: final, whatever is observed about the run afterwards. */
export function isSealedOutcomeChain(chain: SessionChain): boolean {
  return Boolean(chain.outcomeSet?.completion)
}

export function isFinishedOutcomeChain(chain: SessionChain): boolean {
  return (
    chain.state === 'cancelled' ||
    // The seal is read before anything is derived: drift or a lost host cannot un-finish a run.
    isSealedOutcomeChain(chain) ||
    Boolean(
      chain.outcomeSet?.outcomes &&
      sessionOutcomeProgress(chain.outcomeSet).lifecycle === 'complete'
    )
  )
}

export function sameSessionOutcomeSource(left: SessionChain, right: SessionChain): boolean {
  return (
    left.sourcePaneKey === right.sourcePaneKey &&
    (left.sourceWorktreeId ?? left.worktreeId) === (right.sourceWorktreeId ?? right.worktreeId) &&
    (left.placement ?? left.hostId ?? 'local') === (right.placement ?? right.hostId ?? 'local')
  )
}

export function assertNoUnfinishedLegacySource(chains: readonly SessionChain[]): void {
  const legacy = chains.find(
    (chain) => !chain.outcomeSet && chain.state !== 'done' && chain.state !== 'cancelled'
  )
  if (legacy) {
    throw new Error(
      `This source has an unfinished legacy Next plan (${legacy.id}, ${legacy.state}). Finish or cancel that plan before binding outcomes; its launched steps cannot be adopted.`
    )
  }
}

/** Called synchronously at the durable write, after per-chain asynchronous admission. */
export function assertUniqueSessionOutcomeSource(
  chains: readonly SessionChain[],
  candidate: SessionChain
): void {
  if (!candidate.outcomeSet) {
    return
  }
  const old = chains.find((chain) => chain.id === candidate.id)
  // Historical duplicate owners must still persist reconciliation and recovery receipts.
  if (
    old?.outcomeSet &&
    sameSessionOutcomeSource(old, candidate) &&
    (!isFinishedOutcomeChain(old) || isFinishedOutcomeChain(candidate))
  ) {
    return
  }
  const peers = chains.filter((chain) => sameSessionOutcomeSource(chain, candidate))
  assertNoUnfinishedLegacySource(peers)
  const duplicate = peers.find(
    (chain) =>
      chain.id !== candidate.id &&
      chain.outcomeSet &&
      !isFinishedOutcomeChain(chain) &&
      !isFinishedOutcomeChain(candidate)
  )
  if (duplicate) {
    throw new Error(
      `This source already has a committed outcome set (${duplicate.id}). Edit that set instead of creating another owner.`
    )
  }
}

export function nextSessionOutcomeSourceId(
  chains: readonly SessionChain[],
  source: SessionChain
): string {
  const base = `source_${createHash('sha256')
    .update(JSON.stringify([source.sourcePaneKey, source.sourceWorktreeId ?? source.worktreeId]))
    .digest('hex')
    .slice(0, 40)}`
  let id = base
  for (let n = 1; chains.some((chain) => chain.id === id); n++) {
    id = `${base}_${n}`
  }
  return id
}

export function forkFinishedOutcomeSource(
  chains: readonly SessionChain[],
  base: SessionChain,
  input: SessionOutcomeCommit
): { base: SessionChain; input: SessionOutcomeCommit } {
  const old = chains.find((chain) => chain.id === base.id)
  if (!old?.outcomeSet || !isFinishedOutcomeChain(old)) {
    return { base, input }
  }
  const sealed = isSealedOutcomeChain(old)
  if (
    // A sealed run is never revised in place: a supersede or a reused outcome id is new work too.
    !sealed &&
    (input.supersede ||
      input.outcomes.some((outcome) =>
        old.outcomeSet!.outcomes.some((prior) => prior.id === outcome.id)
      ))
  ) {
    return { base, input }
  }
  if (input.expectedRevision !== old.outcomeSet.revision) {
    throw new Error('Outcome revision conflict. Reload the saved outcomes before editing.')
  }
  // What the sealed run already ran stays with it; the new generation carries only new stages.
  const steps = sealed
    ? base.steps.filter((step) => !old.steps.some((prior) => prior.id === step.id))
    : base.steps
  // Only NEW work starts a new run. Taking Done back, or restating part of what was proven with
  // nothing added, asks for an edit of the sealed run itself — a fork of that would run proven
  // work a second time, so it is refused in the sealed run's own words.
  const proven = provenDefinitions(old)
  if (
    sealed &&
    (input.clearSessionFinish ||
      !(steps.length || input.outcomes.some((outcome) => !restatesProven(proven, outcome))))
  ) {
    throw new Error(SESSION_RUN_SEALED_ERROR)
  }
  const kept = new Set(steps.map((step) => step.id))
  // A supersede, a drawn step, a plan version and a removal all speak about the run that is
  // sealed; the new generation starts from nothing, so none of them is carried into it.
  const {
    supersede: _supersede,
    drawsSteps: _draws,
    planVersion: _planVersion,
    removals: _removals,
    ...fresh
  } = input
  return {
    base: {
      id: nextSessionOutcomeSourceId(chains, base),
      workspacePath: base.workspacePath,
      worktreeId: base.worktreeId,
      sourcePaneKey: base.sourcePaneKey,
      sourceRowKey: base.sourceRowKey,
      sourceWorktreeId: base.sourceWorktreeId,
      hostId: base.hostId,
      placement: base.placement,
      auto: true,
      steps,
      currentIndex: 0,
      state: 'waiting',
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    input: {
      ...(sealed ? fresh : input),
      ...(sealed ? { outcomes: newGenerationOutcomes(proven, input.outcomes, kept) } : {}),
      expectedRevision: 0
    }
  }
}

type OutcomeDefinition = SessionOutcomeCommit['outcomes'][number]

/**
 * What a new generation takes from a commit on a sealed run: each outcome scoped to the new stages,
 * and none the run already proved exactly as it is restated — carried, it would be proven, and its
 * actions run, a second time. A dependency on proven work was met by the sealed run. A restatement
 * stays only when nothing else is left to own the new stages.
 */
function newGenerationOutcomes(
  proven: ReadonlyMap<string, string | null>,
  outcomes: readonly OutcomeDefinition[],
  kept: ReadonlySet<string>
): OutcomeDefinition[] {
  const scoped = outcomes.map((outcome) => {
    const { stepIds, ...definition } = outcome
    const own = stepIds?.filter((id) => kept.has(id)) ?? []
    return own.length ? { ...definition, stepIds: own } : definition
  })
  const fresh = scoped.filter((_, index) => !restatesProven(proven, outcomes[index]!))
  if (!fresh.length) {
    return scoped
  }
  const carried = new Set(fresh.map((outcome) => outcome.id))
  const met = (id: string): boolean => proven.has(id) && !carried.has(id)
  return fresh.map((outcome) =>
    outcome.dependsOn.some(met)
      ? { ...outcome, dependsOn: outcome.dependsOn.filter((id) => !met(id)) }
      : outcome
  )
}

/** Every outcome the sealed run proved, as the schema orders its definition. */
function provenDefinitions(old: SessionChain): Map<string, string | null> {
  return new Map(
    old.outcomeSet!.outcomes.map((outcome) => [
      outcome.id,
      canonicalDefinition(sessionOutcomeDefinition(outcome))
    ])
  )
}

/** A definition the schema refuses restates nothing: the commit's own validation names it. */
function restatesProven(
  proven: ReadonlyMap<string, string | null>,
  outcome: OutcomeDefinition
): boolean {
  const offered = canonicalDefinition(outcome)
  return offered !== null && proven.get(outcome.id) === offered
}

/** Thrown by a commit that would edit a sealed run; a caller with its own words for it asks this. */
export function isSealedRunRefusal(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_RUN_SEALED_ERROR
}

/** Key order is the caller's; the schema's own order is what makes two definitions comparable. */
function canonicalDefinition(definition: OutcomeDefinition): string | null {
  const parsed = sessionOutcomeDefinitionSchema.safeParse(definition)
  return parsed.success ? JSON.stringify(parsed.data) : null
}

/**
 * A commit on a sealed run that names exactly the work the run already proved. It is a replay (a
 * reconnecting client, a repeated save, a card filing), and replaying success must not start a
 * second run of the same work: the sealed chain is returned as it is. One read before the revision
 * the run holds is refused as a revision conflict. The same work under another finish or plan
 * version would edit the seal, so that is refused; anything else is new work and returns null.
 */
export function restatesSealedOutcomeSource(
  chains: readonly SessionChain[],
  base: SessionChain,
  input: SessionOutcomeCommit
): SessionChain | null {
  const old = chains.find((chain) => chain.id === base.id)
  if (!old?.outcomeSet || !isSealedOutcomeChain(old)) {
    return null
  }
  const proven = provenDefinitions(old)
  const sameWork =
    input.outcomes.length === proven.size &&
    input.outcomes.every((outcome) => restatesProven(proven, outcome)) &&
    base.steps.every((step) => old.steps.some((prior) => prior.id === step.id))
  if (!sameWork) {
    return null
  }
  // A restatement sent from an older revision is a stale view, refused as on every other door.
  if (input.expectedRevision !== old.outcomeSet.revision) {
    throw new Error('Outcome revision conflict. Reload the saved outcomes before editing.')
  }
  const finish = input.sessionFinish
  const recorded = old.outcomeSet.sessionFinish
  if (
    input.supersede ||
    input.removals?.length ||
    input.clearSessionFinish ||
    (finish && (finish.action !== recorded?.action || finish.folderId !== recorded?.folderId))
  ) {
    throw new Error(SESSION_RUN_SEALED_ERROR)
  }
  return old
}
