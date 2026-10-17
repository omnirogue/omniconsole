import { workflowRouteMayJudge, type WorkflowRoute } from './workflow-graph'
import { families } from './workflow-graph-improve'
import type { LocalWorkflowGraphRun } from './local-workflow-graph-view'
import type { WorkflowRunTarget } from './workflow-run-result'

export const QUICK_DISCOVER_FIND_INSTRUCTION =
  'Every file in scope is attached below with its path and line numbers. Read all of it and find the results that fit the goal; for code, real defects. Trace the actual control flow across files: a defect may span several. Report only what the attached code backs, each with location = path:line (or path:start-end), a severity by blast radius (critical, high, medium, low), and detail = the trigger, the concrete failure scenario (input or state → wrong result), the quoted code and the fix. Most severe first. Be adversarial and specific: report nothing rather than something you cannot back.'

/** The engine's list ceiling (WORKFLOW_MAX_LIST_ITEMS): one reader reports the whole scope. */
const QUICK_DISCOVER_MAX_RESULTS = 20
export const QUICK_DISCOVER_FIND_STEP = 'find'

/**
 * One frontier call reads the whole scope (the host attaches it, graph admission) and lists its
 * results; an independent family verifies them when available. The host renders the report.
 */
export function quickDiscoverWorkflow(available: readonly WorkflowRoute[], verify = false) {
  const all = families(available)
  const reader = all.find((route) => workflowRouteMayJudge(route)) ?? all[0]!
  const verifier = all.find((route) => route !== reader && workflowRouteMayJudge(route))
  return {
    title: 'Quick Discover',
    template: 'quick-discover',
    steps: [
      {
        id: QUICK_DISCOVER_FIND_STEP,
        kind: 'do',
        title: 'Read everything',
        instruction: QUICK_DISCOVER_FIND_INSTRUCTION,
        agents: [{ route: reader }],
        inputs: [],
        list: { maxItems: QUICK_DISCOVER_MAX_RESULTS, evidence: true }
      },
      ...(verify && verifier
        ? [
            {
              id: 'verify',
              kind: 'review',
              title: 'Verify',
              instruction:
                'Independently check this finding against the sources. Refute it if possible. VERDICT: PASS only when the evidence establishes it; FAIL when disproved; UNSURE when unsettled. Quote the evidence.',
              agents: [{ route: verifier }],
              inputs: [QUICK_DISCOVER_FIND_STEP],
              forEach: {
                step: QUICK_DISCOVER_FIND_STEP,
                limit: QUICK_DISCOVER_MAX_RESULTS
              }
            }
          ]
        : [])
    ]
  }
}

/** Keep every reader result, using a Verify step's verdict when it ran. */
export function quickDiscoverTargets(graph: LocalWorkflowGraphRun): WorkflowRunTarget[] {
  const reviewed = graph.steps.flatMap((step) =>
    step.rounds.flatMap((round) =>
      (round.targets ?? []).map((target) => ({
        ...target,
        step: step.id,
        round: round.round
      }))
    )
  )
  const byKey = new Map(reviewed.map((target) => [target.key, target]))
  const step = graph.steps.find((entry) => entry.id === QUICK_DISCOVER_FIND_STEP)
  return (step?.rounds ?? []).flatMap((round) =>
    (round.items ?? []).map((item) => {
      const target = byKey.get(item.key)
      const { unchecked, screened, webUnbacked, evidence, ...reviewed } = target ?? {}
      const check = evidence ?? item.evidence
      return {
        step: QUICK_DISCOVER_FIND_STEP,
        round: round.round,
        ...(item.sourceCallId ? { sourceCallId: item.sourceCallId } : {}),
        ...(item.alsoFrom ? { alsoFrom: item.alsoFrom } : {}),
        key: item.key,
        title: item.title,
        location: item.location,
        severity: item.severity,
        tally: target?.tally ?? ('unverified' as const),
        votes: target?.votes ?? [],
        repeats: item.repeats,
        ...(!target ? { singlePass: true as const } : {}),
        ...reviewed,
        ...(unchecked ? { unchecked: true as const } : {}),
        ...(screened ? { screened: true as const } : {}),
        ...(webUnbacked ? { webUnbacked: true as const } : {}),
        ...(check ? { evidence: check.status } : {}),
        ...(check?.preVerify ? { preVerify: check.preVerify } : {}),
        ...(target?.jev ? { jevScore: target.jev.score } : {}),
        detail: item.detail
      }
    })
  )
}
