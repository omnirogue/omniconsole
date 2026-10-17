import { JEV_DEFAULT_RUBRIC } from '../../../../shared/jev-rubric'
import { WORKFLOW_DEFAULT_PATIENCE, type WorkflowStep } from '../../../../shared/workflow-graph'
import { planImproveUnchanged } from './graph-improve-baseline'
import { graphImproveRoles, type ImproveVersion } from './graph-improve-decide'
import { improveNextArchive, improveParentRole, improveParents } from './graph-improve-archive'
import { settleImproveRound, type ImproveCarry } from './graph-improve-round'
import { improveMeasuredProgress, improvePassingKept } from './graph-improve-progress'
import { planImproveFinal } from './graph-improve-final'
import {
  graphImproveChangesCode,
  graphImproveFinalTest,
  graphImproveMeasured,
  graphImprovePopulation,
  graphImproveReflects,
  graphImproveSkipsRepeatedChanges
} from './graph-improve-rules'
import { graphImproveFrontier } from './graph-improve-frontier'
import { nextImproveReflection } from './graph-improve-reflection'
import { graphImproveNotJudged as notJudged, publishImprove } from './graph-improve-publish'
import type {
  GraphImproveBrief,
  GraphImproveRound,
  GraphImproveTrail,
  GraphLoopState,
  GraphStepRun
} from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import { runGraphStep } from './graph-step'

const pending = (run: GraphStepRun | undefined) =>
  !!run && (run.state === 'waiting' || run.state === 'active')

/**
 * Improve until it stops getting better (docs/workflows/WORKFLOW-CORE-2026-09-22.md §10).
 *
 * Round one makes first versions; the judges pick the best, which becomes the incumbent. Every
 * later round the improvers make challengers, the judges compare them blind with the incumbent,
 * and a challenger replaces it only when it clearly wins: a tie, an unsure JEV with no model
 * judge, or a round nobody could judge keeps the incumbent. The loop stops after `patience`
 * rounds in a row without an improvement (after one round of fundamentally different approaches,
 * unless exploring is low), or at the round limit. With frontier seats pinned, every round after
 * one without gain runs on them, and the search never stops on a plateau before one such round
 * was judged. Its output is the best version found, never merely the newest.
 */
export function runImproveLoop(scope: GraphScope, doStep: WorkflowStep, judge: WorkflowStep): void {
  const repeat = scope.config.spec.repeat!
  const explore = repeat.explore ?? 'normal'
  const doRuns = scope.runs[doStep.id]
  const judgeRuns = scope.runs[judge.id]
  const measured = graphImproveMeasured(scope.config)
  const trail: GraphImproveTrail = {
    rounds: [],
    stale: 0,
    patience: repeat.patience ?? WORKFLOW_DEFAULT_PATIENCE,
    ...(measured ? { measured: true as const } : {})
  }
  // Makers aim at what the judges will look for from the first version on, not only after a
  // judged round (one first version, or a round the check decided, has no judges' notes).
  const rubric = judge.instruction.trim() || JEV_DEFAULT_RUBRIC
  const changesCode = graphImproveChangesCode(scope.config)
  const population = graphImprovePopulation(scope.config)
  const frontier = graphImproveFrontier(scope.config, doStep)
  const reflects = graphImproveReflects(scope.config)
  // Rebuilt on every replay from the same rounds, so a repeat always finds the same first.
  const checkedChanges = graphImproveSkipsRepeatedChanges(scope.config)
    ? new Map<string, ImproveVersion>()
    : undefined
  let carry: ImproveCarry = {}
  if (changesCode) {
    // "No change" (the code as it is) is checked first and holds the lead from round one.
    const unchanged = planImproveUnchanged(scope, doStep)
    if (!unchanged) {
      scope.loop = { round: 1, maxRounds: repeat.maxRounds, status: 'running', improve: trail }
      return
    }
    carry = { best: unchanged }
  }
  // What the search started from, for the final test: "No change", or round 1's best version.
  let start = carry.best
  let unresolvedStreak = 0
  let divergentNext = false
  let divergentTried = false
  let passingKept = false
  let frontierTried = false
  let status: GraphLoopState['status'] = 'running'
  let round = 1
  for (; round <= repeat.maxRounds; round++) {
    const { best, alternative, feedback, reflection } = carry
    const escalated = !!frontier && trail.stale > 0
    // While "No change" holds, improvers still make a first change rather than improve on it.
    const unchanged = best?.round === 0
    const mode: GraphImproveRound['mode'] = divergentNext
      ? 'divergent'
      : !best || unchanged
        ? 'first'
        : 'improve'
    // With one version to build on every parent is undefined, and every improver gets the best.
    const parents = improveParents(carry, population, doStep.agents.length)
    const roles = graphImproveRoles(doStep.agents.length, mode, explore).map((role, index) =>
      improveParentRole(role, parents[index])
    )
    const briefs: GraphImproveBrief[] = roles.map((role, index) => {
      const parent = parents[index]
      const base = parent?.version ?? best
      const fromUnchanged = base?.round === 0
      return {
        role,
        round,
        rubric,
        ...(repeat.prompts ? { prompts: repeat.prompts } : {}),
        ...(base && !fromUnchanged ? { best: briefOf(base) } : {}),
        ...(parent && parent.kept !== 'best' ? { parent: parent.kept } : {}),
        ...(role === 'explore' && alternative ? { alternative: briefOf(alternative) } : {}),
        ...(feedback ? { feedback } : {}),
        ...(reflects && reflection ? { reflection } : {}),
        ...(repeat.check ? { checkCommand: repeat.check.command } : {}),
        ...(measured && repeat.check
          ? {
              measuredCheck: {
                cases: repeat.check.cases ?? [],
                ...(repeat.check.predict ? { predict: true as const } : {})
              }
            }
          : {}),
        ...(base?.check ? { check: base.check } : {}),
        ...(changesCode
          ? { change: { protect: repeat.check?.protect ?? [], unchanged: fromUnchanged } }
          : {})
      }
    })
    const doRun = runGraphStep(scope, doStep, round, {
      inLoop: true,
      improve: briefs,
      ...(escalated ? { frontier } : {})
    })
    doRuns.push(doRun)
    const entry: GraphImproveRound = {
      round,
      mode,
      ...(escalated ? { escalated: true as const } : {}),
      candidates: [],
      judgedBy: [],
      result: 'pending'
    }
    trail.rounds.push(entry)
    if (pending(doRun)) {
      break
    }
    if (doRun.state === 'not-run' && (!scope.config.improveUnresolvedRounds || !carry.best)) {
      entry.result = 'failed'
      entry.reason = doRun.reason
      status = 'failed'
      break
    }
    const challengers: ImproveVersion[] = (doRun.texts ?? []).map((text) => {
      const parent = parents[text.agentIndex]?.version
      return {
        text,
        round,
        role: roles[text.agentIndex],
        ...(parent ? { parent: { round: parent.round, name: parent.text.name } } : {})
      }
    })
    let improved = false
    if (!challengers.length) {
      entry.result = 'failed'
      entry.reason = doRun.reason ?? `${doStep.title} returned no version.`
      judgeRuns.push(notJudged(judge, round, `Not run: ${doStep.title} returned no version.`))
      if (!carry.best) {
        status = 'failed'
        break
      }
    } else {
      const settled = settleImproveRound(scope, {
        doStep,
        judge,
        doRun,
        round,
        challengers,
        entry,
        carry,
        ...(checkedChanges ? { checkedChanges } : {})
      })
      if (!settled) {
        break
      }
      improved = settled.improved
      if (measured && improved && !improveMeasuredProgress(carry.best, settled.carry.best)) {
        improved = false
        entry.noGain = true
      }
      const archive = improveNextArchive({
        before: carry,
        after: settled.carry,
        challengers,
        population
      })
      carry = archive ? { ...settled.carry, archive } : settled.carry
      if (reflects) {
        const next = nextImproveReflection({
          previous: reflection,
          challengers,
          result: entry.result,
          before: best,
          after: carry.best,
          weakest: carry.feedback?.weakest
        })
        carry = { ...carry, reflection: next }
      }
      start ??= carry.best
      const check = repeat.check
      if (
        check?.stopWhenPassing &&
        carry.best?.check?.passed &&
        carry.best.check.score === undefined
      ) {
        status = 'verified'
        break
      }
      if (measured && improvePassingKept(entry, carry.best)) {
        status = 'verified'
        passingKept = true
        break
      }
    }
    const unresolved =
      scope.config.improveUnresolvedRounds &&
      (entry.result === 'unjudged' || entry.result === 'failed')
    unresolvedStreak = unresolved ? unresolvedStreak + 1 : 0
    // A round with a best version to beat (from round one, "No change") can bring no gain.
    if (!unresolved && best) {
      if (improved) {
        trail.stale = 0
        divergentNext = false
        divergentTried = false
        frontierTried = false
      } else {
        trail.stale++
        frontierTried = frontierTried || escalated
        // A plateau stands only once frontier models had a judged round, while a round is left.
        const plateau = !frontier || frontierTried || round >= repeat.maxRounds
        if (mode === 'divergent' && plateau) {
          status = 'plateau'
          break
        }
        if (trail.stale >= trail.patience) {
          if (explore === 'low' || divergentTried) {
            if (plateau) {
              status = 'plateau'
              break
            }
          } else {
            divergentNext = true
            divergentTried = true
          }
        }
      }
    }
    if (round === repeat.maxRounds) {
      status = 'max-rounds'
      break
    }
    if (unresolvedStreak >= 2) {
      status = 'undecided'
      break
    }
  }
  const best = carry.best
  if (best) {
    trail.best = { round: best.round, name: best.text.name, seatId: best.text.seatId }
  }
  if (status !== 'running') {
    trail.stop = passingKept
      ? 'passing-kept'
      : status === 'plateau' ||
          status === 'max-rounds' ||
          status === 'verified' ||
          status === 'undecided'
        ? status
        : 'failed'
  }
  scope.loop = {
    round: Math.min(round, repeat.maxRounds),
    maxRounds: repeat.maxRounds,
    status,
    improve: trail
  }
  if (status === 'running') {
    return
  }
  if (best && start && graphImproveFinalTest(scope.config)) {
    trail.final = planImproveFinal(scope, doStep.id, scope.loop.round, { best, start })
    if (!trail.final.verdict) {
      // Still running: nothing is published until the final test has its verdict.
      scope.loop.status = 'running'
      return
    }
  }
  publishImprove(scope, doStep, judge, best)
}

function briefOf(version: ImproveVersion) {
  return { markdown: version.text.markdown, name: version.text.name, round: version.round }
}
