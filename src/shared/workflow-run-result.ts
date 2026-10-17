import type { LocalWorkflowFindStarted } from './local-workflow-find-request'
import type {
  LocalWorkflowCallView,
  LocalWorkflowEvidenceStatus,
  LocalWorkflowGraphItem,
  LocalWorkflowGraphRound,
  LocalWorkflowGraphRun,
  LocalWorkflowView
} from './local-workflow-view'
import type { LocalWorkflowPreVerify } from './local-workflow-graph-view'
import type { WorkflowClaimRow } from './workflow-claim-table'
import type { WorkflowFindTrail } from './workflow-find-trail'
import type { WorkflowWebCheck } from './workflow-graph-web'
import type { WorkflowLoopView } from './workflow-improve-trail'
import { quickDiscoverTargets } from './workflow-graph-quick-discover'

/** Anything the app did not record is said to be unknown, never reported as 0. */
export type Unknown = 'unknown'
/** `cli`: the provider's own bill; `table`: list prices times the tokens; `unknown`: neither. */
export type WorkflowRunCostSource = 'cli' | 'table' | Unknown

/** One review target as the run left it: what was found, where, and what the reviewers said. */
export type WorkflowRunTarget = {
  step: string
  round: number
  reviewRound?: number
  sourceCallId?: string
  alsoFrom?: string[]
  key: string
  title: string
  location: string
  severity: LocalWorkflowGraphItem['severity']
  tally: 'confirmed' | 'refuted' | 'unverified'
  impact?: LocalWorkflowGraphItem['impact']
  votes: (string | null)[]
  /** JEV's 0–4 screen score, the run's own estimate of the target's value. */
  jevScore?: number
  /**
   * JEV verify (`jevVerify` on the review): JEV's probability, 0–1, that the item is a real,
   * in-scope defect; absent when JEV was not asked or gave no answer.
   */
  jevVerify?: number
  /** Live JEV verify confirmed it (p >= confirmAt) after the reviewers left it unverified. */
  confirmedBy?: 'jev'
  /** Live JEV verify set it aside (refuted at p <= rejectAt) once reviewers left it unverified. */
  refutedBy?: 'jev'
  /** JEV set it aside, then a later report it never saw put it back to unverified. */
  resurfaced?: true
  /** Resurfaced after live JEV verify set it aside at this probability. */
  setAsideAt?: number
  /** Quick Discover: one model's single read of the scope; no reviewer or JEV checked it. */
  singlePass?: true
  alsoReported?: NonNullable<LocalWorkflowGraphRound['targets']>[number]['alsoReported']
  repeats: number
  unchecked?: true
  screened?: true
  /** The app's check of the finder's quote, for scoring whether `missing` predicts refuted. */
  evidence?: LocalWorkflowEvidenceStatus
  /** Evidence rules 2: the app's check of its citations and absence searches before review. */
  preVerify?: LocalWorkflowPreVerify
  /** A run that reads pages: the app's checks of its quotes; unbacked means none was found. */
  webChecks?: WorkflowWebCheck[]
  webUnbacked?: true
  detail: string
}

export type WorkflowRunCall = {
  id: string
  stage: string
  route?: string
  model: string
  effort: string | null
  state: LocalWorkflowCallView['state']
  attempt: number
  durationMs: number | Unknown
  tokens: { input: number; output: number } | Unknown
  /** Every priced terminal attempt, including billed failures. */
  costUsd: number | Unknown
  costSource: WorkflowRunCostSource
  costPartial?: true
  error?: string
  /** A run that reads pages: the app's own checks of the web quotes in this call's answer. */
  webChecks?: WorkflowWebCheck[]
}

/** `omni workflow run --json`: everything a benchmark needs from one settled run. */
export type WorkflowRunResult = LocalWorkflowFindStarted & {
  template: string
  state: LocalWorkflowView['state']
  error?: string
  /** Where the run was placed, frozen at admission, and who asked an agent to start it. */
  placement?: LocalWorkflowView['placement']
  requestedBy?: string
  requestedById?: string
  request?: string
  /** The final answer as the model wrote it. */
  markdown: string | null
  /** A run that reads pages: the app's own part (claims table, Sources), never part of `markdown`. */
  appendix?: string
  results: {
    steps: { id: string; kind: string; state: string; reason?: string; rounds: number }[]
    /** Review targets in the order the run ranked them, round by round. */
    targets: WorkflowRunTarget[]
    standings: {
      step: string
      round: number
      label: string
      name: string
      place: number
      votes: number
    }[]
    find?: WorkflowFindTrail
    loop?: WorkflowLoopView
    /** The report's ranking; `why` and `next` are model-written, `webChecks` the app's own. */
    ranking?: LocalWorkflowGraphRun['ranking']
    /** A run that reads pages: each claim with its settled status and the app's quote checks. */
    claims?: WorkflowClaimRow[]
    /** Evidence rules 2: results checked before review, dropped (no file cited exists), flagged. */
    preVerify?: { checked: number; dropped: number; flagged: number }
  }
  gaps: string[]
  /** Calls the run lost that no other account or model family could take: not a plain completion. */
  degraded?: { lostCalls: number; steps: string[] }
  timing: {
    /** The host's own clock, start to settle. */
    wallClockMs: number | Unknown
    /** How long the CLI followed it, from asking the window to start to the settled read. */
    followedMs: number
  }
  calls: WorkflowRunCall[]
  usage: {
    /** The run's total, only when every call reported its tokens; otherwise unknown. */
    tokens: { kind: 'reported' | 'estimated'; input: number; output: number } | Unknown
    /** Some calls reported and some did not: the sum of the known ones, never a total. */
    partialTokens?: { input: number; output: number; knownCalls: number; unknownCalls: number }
    /** Calls that reported tokens, of all calls. */
    callsWithTokens: number
    callsTotal: number
    /** The priced calls summed; unknown when no call was priced. */
    costUsd: number | Unknown
    /** Some calls were not priced: `costUsd` is the known part, never a total. */
    costPartial?: true
    /** `cli` only when every priced call carried the provider's own bill. */
    costSource: WorkflowRunCostSource
  }
}

function targetsOf(step: string, round: LocalWorkflowGraphRound): WorkflowRunTarget[] {
  return (round.targets ?? []).map((target) => ({
    step,
    round: target.round ?? round.round,
    reviewRound: round.round,
    ...(target.sourceCallId ? { sourceCallId: target.sourceCallId } : {}),
    ...(target.alsoFrom ? { alsoFrom: target.alsoFrom } : {}),
    key: target.key,
    title: target.title,
    location: target.location,
    severity: target.severity,
    tally: target.tally,
    votes: target.votes,
    ...(target.impact ? { impact: target.impact } : {}),
    ...(target.jev ? { jevScore: target.jev.score } : {}),
    ...(target.jevVerify !== undefined ? { jevVerify: target.jevVerify } : {}),
    ...(target.confirmedBy ? { confirmedBy: target.confirmedBy } : {}),
    ...(target.refutedBy ? { refutedBy: target.refutedBy } : {}),
    ...(target.resurfaced ? { resurfaced: true as const } : {}),
    ...(target.setAsideAt !== undefined ? { setAsideAt: target.setAsideAt } : {}),
    repeats: target.repeats,
    ...(target.alsoReported?.length ? { alsoReported: target.alsoReported } : {}),
    ...(target.unchecked ? { unchecked: true as const } : {}),
    ...(target.screened ? { screened: true as const } : {}),
    ...(target.evidence ? { evidence: target.evidence.status } : {}),
    ...(target.evidence?.preVerify ? { preVerify: target.evidence.preVerify } : {}),
    ...(target.webChecks ? { webChecks: target.webChecks } : {}),
    ...(target.webUnbacked ? { webUnbacked: true as const } : {}),
    detail: target.detail
  }))
}

/** A target JEV screened out was never going to review, so it counts as flagged, not dropped. */
function preVerifyCounts(targets: readonly WorkflowRunTarget[]) {
  const checked = targets.filter((target) => target.preVerify)
  const dropped = checked.filter((target) => target.preVerify!.dropped && !target.screened)
  const flagged = checked.filter(
    (target) => !dropped.includes(target) && target.preVerify!.flags.length
  )
  return checked.length
    ? { preVerify: { checked: checked.length, dropped: dropped.length, flagged: flagged.length } }
    : {}
}

function callOf(call: LocalWorkflowCallView): WorkflowRunCall {
  return {
    id: call.id,
    stage: call.stageId,
    ...(call.agent ? { route: call.agent } : {}),
    model: call.model,
    effort: call.effort,
    state: call.state,
    attempt: call.attempt,
    durationMs:
      call.startedAt !== undefined && call.endedAt !== undefined
        ? call.endedAt - call.startedAt
        : 'unknown',
    tokens: call.tokens ? { ...call.tokens } : 'unknown',
    costUsd: call.cost?.usd ?? 'unknown',
    costSource: call.cost?.source ?? 'unknown',
    ...(call.cost?.partial ? { costPartial: true as const } : {}),
    ...(call.error ? { error: call.error } : {}),
    ...(call.webChecks ? { webChecks: call.webChecks } : {})
  }
}

function usageOf(view: LocalWorkflowView, calls: WorkflowRunCall[]): WorkflowRunResult['usage'] {
  const known = calls.flatMap((call) => (call.tokens === 'unknown' ? [] : [call.tokens]))
  const complete = calls.length > 0 && known.length === calls.length
  const priced = calls.flatMap((call) =>
    call.costUsd === 'unknown' ? [] : [{ usd: call.costUsd, source: call.costSource }]
  )
  return {
    tokens: complete && view.usage?.tokens ? view.usage.tokens : 'unknown',
    ...(!complete && known.length
      ? {
          partialTokens: {
            input: known.reduce((sum, tokens) => sum + tokens.input, 0),
            output: known.reduce((sum, tokens) => sum + tokens.output, 0),
            knownCalls: known.length,
            unknownCalls: calls.length - known.length
          }
        }
      : {}),
    callsWithTokens: known.length,
    callsTotal: calls.length,
    costUsd: priced.length ? priced.reduce((sum, call) => sum + call.usd, 0) : 'unknown',
    ...(priced.length && (priced.length < calls.length || calls.some((call) => call.costPartial))
      ? { costPartial: true as const }
      : {}),
    costSource: !priced.length
      ? 'unknown'
      : priced.some((call) => call.source !== 'cli')
        ? 'table'
        : 'cli'
  }
}

export function workflowRunResult(
  view: LocalWorkflowView,
  started: LocalWorkflowFindStarted,
  template: string,
  followedMs: number
): WorkflowRunResult {
  const graph = view.graphRun
  const kinds = new Map(graph?.spec.steps.map((step) => [step.id, step.kind]) ?? [])
  const calls = view.calls.map(callOf)
  const roundTargets = !graph
    ? []
    : graph.spec.template === 'quick-discover'
      ? quickDiscoverTargets(graph)
      : graph.steps.flatMap((step) => step.rounds.flatMap((round) => targetsOf(step.id, round)))
  const absorbed = new Set(
    graph?.steps.flatMap((step) =>
      step.rounds.flatMap((round) =>
        (round.targets ?? []).flatMap((target) => target.alsoMerged ?? [])
      )
    ) ?? []
  )
  const targets = [
    ...new Map(roundTargets.map((target) => [`${target.step}:${target.key}`, target])).values()
  ].filter((target) => !absorbed.has(target.key))
  return {
    ...started,
    template,
    state: view.state,
    ...(view.error ? { error: view.error } : {}),
    ...(view.placement ? { placement: view.placement } : {}),
    ...(view.requestedBy ? { requestedBy: view.requestedBy } : {}),
    ...(view.requestedById ? { requestedById: view.requestedById } : {}),
    ...(view.request ? { request: view.request } : {}),
    markdown: view.result?.markdown ?? null,
    ...(view.result?.appendix ? { appendix: view.result.appendix } : {}),
    results: {
      steps: (graph?.steps ?? []).map((step) => ({
        id: step.id,
        kind: kinds.get(step.id) ?? 'unknown',
        state: step.state,
        ...(step.reason ? { reason: step.reason } : {}),
        rounds: step.rounds.length
      })),
      targets,
      standings: (graph?.steps ?? []).flatMap((step) =>
        step.rounds.flatMap((round) =>
          (round.standings ?? []).map((standing) => ({
            step: step.id,
            round: round.round,
            label: standing.label,
            name: standing.name,
            place: standing.place,
            votes: standing.votes
          }))
        )
      ),
      ...(graph?.find ? { find: graph.find } : {}),
      ...(graph?.loop ? { loop: graph.loop } : {}),
      ...(graph?.ranking ? { ranking: graph.ranking } : {}),
      ...(graph?.claims ? { claims: graph.claims } : {}),
      ...preVerifyCounts(targets)
    },
    gaps: [...(graph?.gaps ?? []), ...(view.discoverRun?.dropped ?? [])],
    ...(graph?.degraded ? { degraded: graph.degraded } : {}),
    timing: {
      wallClockMs: view.finishedAt !== undefined ? view.finishedAt - view.startedAt : 'unknown',
      followedMs
    },
    calls,
    usage: usageOf(view, calls)
  }
}
