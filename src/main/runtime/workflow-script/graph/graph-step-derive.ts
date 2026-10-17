import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { councilMarkdown } from '../presets/council-ranking'
import { graphUncheckedTarget } from './graph-triage'
import {
  graphAttachVerifiedEarly,
  graphCountedViews,
  graphReviewedTarget
} from './graph-review-target'
import {
  badGraphItem,
  graphMatchesItem,
  sameGraphClaim,
  mergeGraphReport,
  readGraphItems,
  type GraphItem
} from './graph-items'
import { repeatsEarlierLine } from '../workflow-earlier-findings'
import {
  graphLabel,
  graphJudgesCompareEveryPair,
  graphStandings,
  parseGraphBallot,
  parseGraphVerdict
} from './graph-parse'
import {
  GRAPH_JEV_SEAT_ID,
  graphPlural,
  type GraphCallView,
  type GraphCandidate,
  type GraphNamedText,
  type GraphStepRun
} from './graph-plan-types'
import { graphUsesLegacyVerification, type GraphScope } from './graph-scope'
import { graphWebRecorder, graphWebTarget } from './graph-web-citations'
import { graphAttachJevVerify, graphJevVerifyPending } from './graph-jev-verify-plan'

type DeriveInput = {
  step: WorkflowStep
  run: GraphStepRun
  round: number
  inLoop: boolean
  instances: (GraphItem | undefined)[]
  /** For-each items over the limit, or dropped by the pre-verify: no call ran for them. */
  unchecked?: GraphItem[]
  /** For-each items JEV set aside as non-findings: no call ran for them either. */
  screenedOut?: GraphItem[]
  candidates: GraphCandidate[]
  known?: GraphItem[]
  /** Review items whose first review gave no answer, to the agent that made it again. */
  standIns?: ReadonlyMap<string, number>
  escalated?: ReadonlySet<string>
}

/**
 * Once every call of a step has settled: what the step produced, from the accepted answers only,
 * and whether it succeeded, degraded or failed. Pure: the same outcomes give the same result.
 */
export function deriveGraphStep(scope: GraphScope, input: DeriveInput): void {
  const { step, run } = input
  // Live JEV verify: the round's verdicts, and so the report and the loop, wait for its answer.
  if (graphJevVerifyPending(scope, step, run)) {
    run.state = 'active'
    graphAttachVerifiedEarly(scope, step, run, input.instances, undefined, input.standIns)
    return
  }
  const record = graphWebRecorder(scope, run)
  const valueOf = (id: string) => {
    const outcome = scope.outcomes.get(id)
    const value = outcome && 'value' in outcome ? outcome.value : undefined
    record?.(value)
    return value
  }
  if (step.kind === 'do' && step.list) {
    const hold = scope.config.earlierHold
    deriveItems(
      input,
      valueOf,
      scope.config.spec.template === 'discover' && !graphUsesLegacyVerification(scope),
      hold?.step === step.id ? hold.lines : undefined
    )
  } else if (step.kind === 'review' && step.forEach) {
    run.targets = input.instances.map((item) => {
      const views = graphCountedViews(
        scope,
        step,
        item!,
        run.calls.filter((view) => view.itemKey === item!.key),
        input.standIns
      )
      const capped =
        !!step.escalate &&
        !input.escalated?.has(item!.key) &&
        !(input.standIns?.has(item!.key) && step.agents.length < 3)
      const target = graphReviewedTarget(scope, step, item!, views, valueOf, capped)
      views.forEach((view, index) => {
        if (target.votes[index]) {
          view.verdict = target.votes[index]!
        }
      })
      return target
    })
    const alone = run.targets.filter((target) => target.sameFamilyOnly).length
    if (alone) {
      run.notes.push(
        `${step.title}: ${graphPlural(alone, 'item')} passed only by reviewers from ${alone === 1 ? 'its' : 'their'} finders' own model families, so ${alone === 1 ? 'it stays' : 'they stay'} unverified.`
      )
    }
    // Items over the limit or set aside are never checked, and never dropped: they go on unverified.
    for (const item of input.unchecked ?? []) {
      run.targets.push(graphUncheckedTarget(step, item))
    }
    for (const item of input.screenedOut ?? []) {
      run.targets.push(graphUncheckedTarget(step, item, true))
    }
    run.targets = run.targets.map((target) => graphWebTarget(scope, target))
    graphAttachJevVerify(scope, step, run)
    const unbacked = run.targets.filter((target) => target.webUnbacked).length
    if (unbacked) {
      run.notes.push(
        `${step.title}: ${graphPlural(unbacked, 'item')} ${unbacked === 1 ? 'rests' : 'rest'} on a web page, and the app found no quote of ${unbacked === 1 ? 'it' : 'them'} there, so ${unbacked === 1 ? 'it stays' : 'they stay'} unverified.`
      )
    }
  } else {
    // JEV's ballot is a Rank step's text; a Do step's screen is not an answer of its own.
    const answers = run.calls.filter((view) => step.kind === 'rank' || !view.jev)
    run.texts = answers.flatMap((view) => {
      const text = namedText(scope, input.instances, view, valueOf(view.id))
      return text ? [text] : []
    })
    if (step.kind === 'review') {
      deriveVerdicts(step, run)
    }
    if (step.kind === 'rank') {
      const labels = input.candidates.map((candidate) => candidate.label)
      const ballots = run.texts.flatMap((text) => {
        const ranking = parseGraphBallot(text.markdown, labels)
        const view = run.calls.find((entry) => entry.id === text.callId)
        if (view && ranking) {
          view.ranking = ranking
        }
        return ranking ? [{ seatId: text.seatId, ranking }] : []
      })
      // JEV first: when JEV was unsure, the model judges it called in decide (the JEV Lab's
      // cascade); its ballot is still kept on the call for the record and the view. When no
      // model judge may compare some pair (two families judging each other's work), JEV's lean
      // is the only neutral one, so it counts with theirs.
      const models = ballots.filter((ballot) => ballot.seatId !== GRAPH_JEV_SEAT_ID)
      const deferred =
        step.jev?.only === true &&
        run.jevUnsure === true &&
        models.length > 0 &&
        graphJudgesCompareEveryPair(
          input.candidates,
          models.map((ballot) => ballot.seatId)
        )
      run.standings = graphStandings(input.candidates, deferred ? models : ballots)
      if (run.jevUnsure && !deferred && models.length > 0 && models.length < ballots.length) {
        run.jevCounted = true
      }
    }
  }
  // A JEV ballot the model judges stood in for is a note, not a missing result.
  const counted = run.calls.filter(
    (view) => !(view.jev && view.status === 'failed' && run.calls.length > 1)
  )
  const total = counted.length
  const done = counted.filter((view) => view.status === 'done').length
  const skipped = counted.filter((view) => view.skipped).length
  const skipNote = `${graphPlural(skipped, 'agent call')} of ${total} ${skipped === 1 ? 'was' : 'were'} skipped: the run finished early.`
  if (!done && total > 0 && skipped === total) {
    // Finish now stopped it before it started: nothing to read, and nothing after it is blocked.
    run.state = 'empty'
    run.reason = `${step.title} was skipped: the run finished early.`
  } else if (!done) {
    run.state = 'failed'
    run.reason = `${step.title} failed: none of its ${graphPlural(total, 'agent call')} returned a result.`
  } else if (done < total) {
    run.state = 'gaps'
    const missed = total - done - skipped
    run.reason = [
      missed ? `${graphPlural(missed, 'agent call')} of ${total} did not return a result.` : '',
      skipped ? skipNote : ''
    ]
      .filter(Boolean)
      .join(' ')
  } else {
    run.state = run.reason ? 'gaps' : 'done'
  }
}

function namedText(
  scope: GraphScope,
  instances: (GraphItem | undefined)[],
  view: GraphCallView,
  value: unknown
): GraphNamedText | undefined {
  const markdown = councilMarkdown(value)
  if (markdown === undefined) {
    return undefined
  }
  const item = view.itemKey ? instances.find((entry) => entry?.key === view.itemKey) : undefined
  // A heading sits outside every fence, so in a run that reads pages it names the item by its key.
  const name = item && (scope.web ? item.key : item.title)
  return {
    label: name ? `${name} · ${graphLabel(view.agentIndex)}` : graphLabel(view.agentIndex),
    name: scope.nameOf(view.seatId),
    markdown,
    agentIndex: view.agentIndex,
    seatId: view.seatId,
    callId: view.id,
    ...(view.itemKey ? { itemKey: view.itemKey } : {})
  }
}

function deriveVerdicts(step: WorkflowStep, run: GraphStepRun): void {
  run.verdicts = step.agents.map((_, index) => {
    const text = run.texts!.find((entry) => entry.agentIndex === index)
    return text ? (parseGraphVerdict(text.markdown) ?? null) : null
  })
  for (const view of run.calls) {
    const verdict = run.verdicts[view.agentIndex]
    if (verdict) {
      view.verdict = verdict
    }
  }
  // Approval is unanimous: every configured reviewer must pass, and a missing vote withholds it.
  // Majority stays for a finding's votes, which classify a claim rather than approve work.
  run.approved = run.verdicts.length > 0 && run.verdicts.every((verdict) => verdict === 'pass')
}

/**
 * A list step's items: every call's items in call order, the same item reported twice merged
 * into the first report (kept on it when worded differently), and a report of something an
 * earlier round already found set aside for that item, applied once the loop ends: changing an
 * earlier round's item here would change prompts that round's calls were already built from.
 */
function deriveItems(
  input: DeriveInput,
  valueOf: (id: string) => unknown,
  discover: boolean,
  earlierLines?: readonly string[]
): void {
  const { step, run, round } = input
  const accepted: GraphItem[] = []
  const known = input.known ?? []
  let merged = 0
  let alreadyKnown = 0
  let earlierRepeats = 0
  let reported = 0
  let dropped = 0
  const knownReports: NonNullable<GraphStepRun['knownReports']> = []
  for (const view of run.calls) {
    const rows = readGraphItems(valueOf(view.id), !!step.list?.evidence) ?? []
    const raw = discover && step.list?.evidence ? rows.filter((item) => !badGraphItem(item)) : rows
    dropped += rows.length - raw.length
    if (raw.length < rows.length) {
      run.notes.push(
        `${view.id}: dropped ${rows.length - raw.length} placeholder rows; valid findings were kept.`
      )
    }
    view.items = raw.length
    reported += raw.length
    for (const entry of raw) {
      // An exact repeat of an earlier run's line is held: it never takes a review slot.
      if (earlierLines && repeatsEarlierLine(earlierLines, entry)) {
        earlierRepeats++
        continue
      }
      const earlier = known.find((item) =>
        discover
          ? [item, ...(item.alsoReported ?? [])].some((report) => sameGraphClaim(report, entry))
          : graphMatchesItem(item, entry)
      )
      if (earlier) {
        alreadyKnown++
        knownReports.push({ key: earlier.key, report: entry, from: view.id })
        continue
      }
      const same = accepted.find((item) => graphMatchesItem(item, entry))
      if (same) {
        mergeGraphReport(same, entry)
        if (view.id !== same.sourceCallId && !same.alsoFrom?.includes(view.id)) {
          same.alsoFrom = [...(same.alsoFrom ?? []), view.id]
        }
        merged++
        continue
      }
      accepted.push({
        ...entry,
        key: `${step.id}.r${round}.${accepted.length + 1}`,
        round,
        sourceCallId: view.id,
        repeats: 0,
        ...(view.itemKey ? { parentKey: view.itemKey } : {})
      })
    }
  }
  if (dropped) {
    run.reason = `${dropped} placeholder rows were discarded; valid findings were kept.`
  }
  run.items = accepted
  if (knownReports.length) {
    run.knownReports = knownReports
  }
  if (merged || alreadyKnown || earlierRepeats) {
    run.notes.push(
      `${step.title}${input.inLoop ? ` round ${round}` : ''}: ${graphPlural(reported, 'item')} reported, ${graphPlural(accepted.length, 'new item')}${merged ? `, ${merged} repeated within the round` : ''}${alreadyKnown ? `, ${alreadyKnown} already known` : ''}${earlierRepeats ? `, ${earlierRepeats} held as exact repeats of earlier runs` : ''}.`
    )
  }
}
