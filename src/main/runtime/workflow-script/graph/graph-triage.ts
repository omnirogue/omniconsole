import textAnswerSchema from '../presets/schemas/text-answer.schema.json'
import { WORKFLOW_SCREEN_SET_ASIDE, type WorkflowStep } from '../../../../shared/workflow-graph'
import { graphSeverityRank, sameGraphReport, type GraphItem } from './graph-items'
import { graphWantsEscalation } from './graph-merged-verdict'
export { graphWantsEscalation } from './graph-merged-verdict'
import {
  GRAPH_JEV_SEAT_ID,
  graphPlural,
  graphValueError,
  type GraphCall,
  type GraphOkOutput,
  type GraphOutcome,
  type GraphStepRun,
  type GraphTarget
} from './graph-plan-types'
import { graphUsesLegacyVerification, type GraphScope } from './graph-scope'
import { graphCallId } from './graph-step-calls'
import { graphFirstReview } from './graph-first-reviewer'
import { graphWebFencer } from './graph-web-citations'
import { JEV_RESPONSE_BYTES } from '../../../structured-decisions/jev-rank-rubric'
import { graphContractKey } from './graph-decision-rules'

/** Used when neither the step nor a brief gives one: what makes a result worth a reviewer. */
export const GRAPH_DEFAULT_SCREEN_RUBRIC = [
  '- Does the result point at a specific place or source (path:line for code)?',
  '- Does it show concrete evidence for its claim: quoted code, data or facts?',
  '- Does it explain a specific mechanism or scenario rather than a vague concern?',
  '- Would acting on it materially advance the goal?',
  '- Is it a real result rather than a vague, speculative, duplicate or style-only remark?'
].join('\n')

/** Used for a shortlist when the frame gives no rubric: what makes an option worth developing. */
export const GRAPH_DEFAULT_OPTION_RUBRIC = [
  '- Would it achieve what the decision is for?',
  '- Is it feasible with the time, money and people available?',
  '- Are its costs and risks acceptable for what it gains?',
  '- Is it specific enough to act on?'
].join('\n')

/** The bullet lines under a brief's heading that matches `heading`. */
export function graphBriefBullets(markdown: string, heading: RegExp): string[] {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => /^#{1,6}\s/.test(line) && heading.test(line))
  const bullets: string[] = []
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) {
      break
    }
    if (/^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line)) {
      bullets.push(line.trim())
    }
  }
  return bullets
}

/** The bullet lines under a `Rubric` heading of a brief, or nothing when it has none. */
export function graphBriefRubric(markdown: string): string | undefined {
  const bullets = graphBriefBullets(markdown, /\brubric\b/i)
  return bullets.length >= 2 ? bullets.join('\n') : undefined
}

function screenRubric(
  step: WorkflowStep,
  settled: readonly { id: string; output: GraphOkOutput }[]
): string {
  const screen = step.forEach?.screen
  if (screen?.rubric) {
    return screen.rubric
  }
  const brief = settled.find((input) => input.id === screen?.rubricFrom)?.output.run.texts?.[0]
  return (brief && graphBriefRubric(brief.markdown)) ?? GRAPH_DEFAULT_SCREEN_RUBRIC
}

const SCREEN_VARIANT_CHARS = 600

/** An item as JEV scores it, with every report merged into it: each may be a different claim. */
const screenText = (item: GraphItem) =>
  [
    `Title: ${item.title}\nSeverity: ${item.severity}\nLocation: ${item.location}\n\n${item.detail}`,
    ...(item.alsoReported ?? []).map((other) => {
      const detail =
        other.detail.length > SCREEN_VARIANT_CHARS
          ? `${other.detail.slice(0, SCREEN_VARIANT_CHARS)} …`
          : other.detail
      return `\nAlso reported as: ${other.title}${other.location ? ` (${other.location})` : ''}\n${detail}`
    })
  ].join('\n')

/** One JEV call per round that scores every item before any reviewer sees one. */
export function graphScreenCall(
  scope: GraphScope,
  input: {
    step: WorkflowStep
    round: number
    inLoop: boolean
    items: readonly GraphItem[]
    settled: readonly { id: string; output: GraphOkOutput }[]
    dependencies: string[]
    /** A shortlist's own rubric (graph-frame-limits.ts). */
    rubric?: string
  }
): GraphCall {
  const { step, round, inLoop } = input
  const fence = graphWebFencer(scope, JEV_RESPONSE_BYTES) ?? ((text: string) => text)
  return {
    id: [step.id, inLoop ? `r${round}` : '', 'screen'].filter(Boolean).join('/'),
    prompt: '',
    schema: textAnswerSchema,
    output: 'text',
    seatId: GRAPH_JEV_SEAT_ID,
    dependencies: input.dependencies,
    stepId: step.id,
    round,
    agentIndex: step.agents.length + 1,
    screen: {
      task: scope.task.prompt,
      rubric: input.rubric ?? screenRubric(step, input.settled),
      candidates: input.items.map((item) => ({ id: item.key, text: fence(screenText(item)) })),
      ...graphContractKey(
        scope.config,
        `${step.id}/${step.forEach?.screen?.shortlist ? 'shortlist' : 'set-aside'}`
      )
    },
    validateSemantics: () => null
  }
}

export type GraphTriage = {
  /** Scored (copies carry `jev`), best first: the reviewers take them in this order. */
  ordered: GraphItem[]
  /** Scored below the set-aside line: never sent to a reviewer, carried on unverified. */
  setAside: GraphItem[]
  note: string
}

const bySeverity = (left: GraphItem, right: GraphItem) =>
  graphSeverityRank(left.severity) - graphSeverityRank(right.severity)

/**
 * Orders a round's items by JEV score (severity breaks ties) and sets aside those JEV scored as
 * non-findings. An item JEV could not score keeps its place by severity among the middling ones;
 * a failed screen falls back to severity order, the way unscreened steps run.
 */
export function graphTriage(
  title: string,
  items: readonly GraphItem[],
  outcome: GraphOutcome,
  below: number = WORKFLOW_SCREEN_SET_ASIDE
): GraphTriage {
  const error = graphValueError(outcome)
  const value = 'value' in outcome ? (outcome.value as { scores?: unknown } | null) : undefined
  const scores =
    !error && value?.scores && typeof value.scores === 'object'
      ? (value.scores as Record<string, number>)
      : undefined
  if (!scores) {
    const reason = error ?? 'no answer'
    return {
      ordered: [...items].sort(bySeverity),
      setAside: [],
      note: `${title}: JEV could not screen the items (${reason}), so they went to the reviewers by severity.`
    }
  }
  const scored = items.map((item) => {
    const score = scores[item.key]
    return Number.isFinite(score) ? { ...item, jev: { score } } : { ...item }
  })
  // An unscored item sorts as middling (2 of 4), never as a non-finding.
  const rank = (item: GraphItem) => item.jev?.score ?? 2
  // Reported more than once is evidence in itself: only a single report is ever set aside.
  const asides = (item: GraphItem) => rank(item) < below && !item.alsoReported?.length
  const kept = scored.filter((item) => !asides(item))
  const setAside = scored.filter(asides)
  const ordered = kept
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        rank(right.item) - rank(left.item) ||
        bySeverity(left.item, right.item) ||
        left.index - right.index
    )
    .map((entry) => entry.item)
  const unscored = scored.filter((item) => !item.jev).length
  const protectedLow = kept.filter((item) => rank(item) < below).length
  return {
    ordered,
    setAside,
    note: `${title}: JEV screened ${items.length} items${unscored ? ` (${unscored} it could not score)` : ''}${setAside.length ? `; ${setAside.length} scored below ${below} of 4 and were set aside as non-findings` : ''}${protectedLow ? `; ${protectedLow} scored as low but were reported more than once, so they stayed` : ''}; the reviewers took the rest best first.`
  }
}

/** A review target in the loop's aggregate, its item carrying later rounds' reports. */
export function graphLoopTarget(target: GraphTarget, merged: GraphItem | undefined): GraphTarget {
  if (!merged) {
    return target
  }
  // The merged copy is the finder's; the round's scores, and the repeats its triage folded in
  // (root-cause merges), live on the target's.
  const folded = (target.item.alsoReported ?? []).filter(
    (report) => !(merged.alsoReported ?? []).some((held) => sameGraphReport(held, report))
  )
  const finders = (target.item.alsoFrom ?? []).filter(
    (id) => id !== merged.sourceCallId && !merged.alsoFrom?.includes(id)
  )
  const item =
    target.item.jev ||
    target.item.impact ||
    target.item.evidence ||
    folded.length ||
    finders.length ||
    target.item.alsoMerged
      ? {
          ...merged,
          ...(target.item.alsoMerged ? { alsoMerged: target.item.alsoMerged } : {}),
          ...(target.item.jev ? { jev: target.item.jev } : {}),
          ...(target.item.impact ? { impact: target.item.impact } : {}),
          ...(target.item.evidence
            ? {
                evidence: target.item.evidence,
                excerpt: target.item.excerpt,
                trigger: target.item.trigger
              }
            : {}),
          ...(folded.length ? { alsoReported: [...(merged.alsoReported ?? []), ...folded] } : {}),
          ...(finders.length ? { alsoFrom: [...(merged.alsoFrom ?? []), ...finders] } : {})
        }
      : merged
  return { ...target, item }
}

/**
 * `target` carrying every report merged in since (later rounds', root-cause repeats' included);
 * `seen` the item JEV judged. JEV never saw a report beyond those, so an item it set aside (by
 * screen or by live verify) goes on unverified, not rejected. A reviewer's refutation stands.
 */
export function graphResurfaced(target: GraphTarget, seen: GraphItem): GraphTarget {
  if (!target.screened && target.refutedBy !== 'jev') {
    return target
  }
  const held = [seen, ...(seen.alsoReported ?? [])]
  const fresh = (target.item.alsoReported ?? []).some(
    (report) => !held.some((known) => sameGraphReport(known, report))
  )
  if (!fresh) {
    return target
  }
  const { screened: _screened, refutedBy: _refutedBy, ...rest } = target
  return {
    ...rest,
    resurfaced: true,
    ...(target.refutedBy === 'jev'
      ? { tally: 'unverified' as const, setAsideAt: target.jevVerify }
      : {})
  }
}

/** An item no reviewer saw: over the limit, or set aside by the screen. */
export function graphUncheckedTarget(
  step: WorkflowStep,
  item: GraphItem,
  screened = false
): GraphTarget {
  const none = step.agents.map(() => null)
  return {
    item,
    votes: none,
    texts: none,
    tally: 'unverified',
    unchecked: true,
    ...(screened ? { screened: true as const } : {})
  }
}

/**
 * Which items go to the other reviewers: those whose first review did not pass (or gave no
 * answer), and every critical one, up to the step's `max` a round. Decided once every first review
 * is in, in the items' order, so the program, its replay and the view escalate the same items.
 * A stand-in's review (graphStandIns) is the item's first. Undefined when the step does not
 * escalate: every reviewer checks every item.
 */
export function graphEscalations(
  scope: GraphScope,
  step: WorkflowStep,
  round: number,
  inLoop: boolean,
  instances: readonly (GraphItem | undefined)[],
  run: GraphStepRun,
  where: string,
  standIns?: ReadonlyMap<string, number>
): Set<string> | undefined {
  if (!step.escalate || step.kind !== 'review' || !step.forEach) {
    return undefined
  }
  const escalated = new Set<string>()
  const reviews = instances.map((item) => graphFirstReview(scope, step, item))
  const firsts = instances.map((item, index) => {
    const standIn = item ? standIns?.get(item.key) : undefined
    return scope.outcomes.get(
      graphCallId(step, round, inLoop, item, standIn ?? reviews[index]!.index)
    )
  })
  if (!firsts.every(Boolean)) {
    return escalated
  }
  let wanted = 0
  let dependent = 0
  instances.forEach((item, index) => {
    const first = firsts[index]!
    // A first review the finishing run never started stays one review: none follow it. Nor
    // does a stand-in's when it was the only other agent: no one is left to escalate to.
    if (
      ('failed' in first && first.skipped) ||
      (standIns?.has(item!.key) && step.agents.length < 3)
    ) {
      return
    }
    dependent += step.escalate!.crossFamily && !reviews[index]!.independent ? 1 : 0
    if (
      graphWantsEscalation(
        step,
        item!,
        first,
        reviews[index]!.independent,
        graphUsesLegacyVerification(scope)
      )
    ) {
      wanted++
      if (escalated.size < step.escalate!.max) {
        escalated.add(item!.key)
      }
    }
  })
  if (wanted) {
    run.notes.push(
      `${where}: ${graphPlural(escalated.size, 'item')} went to ${step.agents.length} reviewers (the first review did not pass, or the item is critical${dependent ? `, or no reviewer from another model family than its finders was available (${dependent})` : ''})${wanted > escalated.size ? `; ${wanted - escalated.size} more kept one review, past the limit of ${step.escalate.max} a round` : ''}.`
    )
  }
  return escalated
}
