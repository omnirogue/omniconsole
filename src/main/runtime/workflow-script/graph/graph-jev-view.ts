import type { LocalWorkflowCallView } from '../../../../shared/local-workflow-view'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowReadsWeb } from '../../../../shared/workflow-graph-web'
import { GraphJevStore, type GraphJevRecord } from './graph-jev-store'
import { graphValueError } from './graph-plan-types'
import { graphWebViewRecords } from './graph-web-sources'

type Records = Record<string, GraphJevRecord>

/** One kind of a run's host records for its view; an unreadable file reads as none. */
function hostRecords(
  executionId: string,
  file?: Parameters<typeof GraphJevStore.forExecution>[2]
): Records {
  try {
    return GraphJevStore.forExecution(executionId, undefined, file).all()
  } catch {
    return {}
  }
}

/** A run's JEV ballots for its view; an unreadable file reads as none, so JEV shows as waiting. */
export function graphJevRecords(executionId: string): Records {
  return hostRecords(executionId)
}

/** A run's objective check results for its view. */
export function graphCheckRecords(executionId: string): Records {
  return hostRecords(executionId, 'checks.json')
}

/** A Find the best run's GitHub facts for its view. */
export function graphFactsRecords(executionId: string): Records {
  return hostRecords(executionId, 'github-facts.json')
}

/** A Discover run's quote checks for its view. */
export function graphEvidenceRecords(executionId: string): Records {
  return hostRecords(executionId, 'evidence.json')
}

/** A run's web sources for its view: metadata only, never page text. */
export function graphWebRecords(executionId: string): Records {
  return hostRecords(executionId, 'web-sources.json')
}

export type GraphHostRecords = {
  jev?: Records
  checks?: Records
  facts?: Records
  evidence?: Records
  web?: Records
}

/** Every host-answered record a graph run's spec can have; a kind it never asks is left out. */
export function graphHostRecords(
  executionId: string,
  spec: WorkflowSpec,
  rules: { webRules?: number } = {}
): GraphHostRecords {
  return {
    ...(spec.steps.some((step) => step.jev || step.forEach?.screen || step.jevVerify) || spec.find
      ? { jev: graphJevRecords(executionId) }
      : {}),
    ...(spec.repeat?.check || spec.find?.check ? { checks: graphCheckRecords(executionId) } : {}),
    ...(spec.find ? { facts: graphFactsRecords(executionId) } : {}),
    ...(spec.steps.some((step) => step.list?.evidence)
      ? { evidence: graphEvidenceRecords(executionId) }
      : {}),
    ...(rules.webRules !== undefined && workflowReadsWeb(spec)
      ? { web: graphWebRecords(executionId) }
      : {})
  }
}

/** The host records as calls of the run view, JEV ballots first. */
export function graphHostCallViews(host: GraphHostRecords): LocalWorkflowCallView[] {
  return [
    ...graphJevCallViews(host.jev),
    ...graphJevCallViews(host.checks, 'check'),
    ...graphJevCallViews(host.facts, 'facts'),
    ...graphJevCallViews(host.evidence, 'evidence'),
    ...graphJevCallViews(host.web, 'web')
  ]
}

/** One outcome map over every kind, or undefined when the run asks none; pages come with text. */
export function graphHostOutcomeRecords(
  host: GraphHostRecords,
  executionId?: string
): Records | undefined {
  const web = host.web && executionId ? graphWebViewRecords(executionId, host.web) : host.web
  return host.jev || host.checks || host.facts || host.evidence || web
    ? { ...host.jev, ...host.checks, ...host.facts, ...host.evidence, ...web }
    : undefined
}

const LABELS = {
  jev: 'JEV',
  check: 'Check',
  facts: 'GitHub',
  evidence: 'Quote check',
  web: 'Web'
} as const

const FAILURES = {
  check: 'The check could not run',
  facts: 'GitHub facts could not be fetched',
  evidence: 'The quotes could not be checked',
  web: 'The web pages could not be read'
} as const

/** A JEV ballot as a call the run view lists: the ballot is its result, the reason its error. */
export function graphJevCallViews(
  records: Readonly<Record<string, GraphJevRecord>> | undefined,
  kind: keyof typeof LABELS = 'jev'
): LocalWorkflowCallView[] {
  const label = LABELS[kind]
  return Object.entries(records ?? {}).map(([callId, record]) => {
    const verb = callId.includes('/screen')
      ? 'screen'
      : callId.endsWith('/jev-verify')
        ? 'verify every item'
        : 'judge'
    const markdown =
      'value' in record.outcome &&
      record.outcome.value &&
      typeof (record.outcome.value as { markdown?: unknown }).markdown === 'string'
        ? (record.outcome.value as { markdown: string }).markdown
        : undefined
    return {
      id: callId,
      stageId: callId.split('/')[0]!,
      seatId: kind,
      seatLabel: label,
      modelLabel: label,
      model: kind,
      effort: null,
      // A failed screen keeps its explanation as markdown; it still failed.
      state: markdown && !graphValueError(record.outcome) ? 'completed' : 'failed',
      attempt: 1,
      attemptLimit: 1,
      transport: 'headless',
      stdout: '',
      stderr: '',
      outputTruncated: false,
      ...(markdown ? { resultMarkdown: markdown } : {}),
      ...(record.detail
        ? {
            error:
              kind === 'jev'
                ? `JEV could not ${verb}: ${record.detail}`
                : `${FAILURES[kind]}: ${record.detail}`
          }
        : {}),
      endedAt: record.at
    }
  })
}
