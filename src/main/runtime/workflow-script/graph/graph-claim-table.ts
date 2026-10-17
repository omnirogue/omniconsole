import type { WorkflowStep } from '../../../../shared/workflow-graph'
import {
  renderWorkflowClaimTable,
  settleWorkflowClaims,
  splitWorkflowClaimTable,
  workflowClaimsFromChecks,
  type WorkflowClaimCheck,
  type WorkflowClaimRow
} from '../../../../shared/workflow-claim-table'
import { graphEvidencePhrase } from './graph-evidence-pack'
import type { GraphScope } from './graph-scope'
import { IGNORABLE } from '../../../../shared/invisible-characters'
import {
  checkWebValue,
  graphWebCheckPagesOf,
  graphWebReportChecks,
  type GraphWebCheck
} from './graph-web-citations'

/** Every claim the fact-checks the step reads recorded, with its tally and the app's quote check. */
export function graphClaimChecks(scope: GraphScope, step: WorkflowStep): WorkflowClaimCheck[] {
  return step.inputs.flatMap((id) => {
    const output = scope.outputs.get(id)
    const input = scope.byId.get(id)
    // A failed review still hands its targets on (graph-step.ts), every one unverified.
    const run = output && 'run' in output ? output.run : undefined
    if (!run || input?.kind !== 'review' || !input.forEach) {
      return []
    }
    return (run.targets ?? []).map((target) => {
      const quote = graphEvidencePhrase(target.item.evidence)
      return {
        key: target.item.key,
        title: target.item.title,
        location: target.item.location,
        tally: target.tally,
        ...(target.unchecked ? { unchecked: true } : {}),
        ...(quote ? { quote } : {})
      }
    })
  })
}

// A claim rests on a page when it names one, however the model spelled or dressed the id.
const NAMES_A_SOURCE = /(?:^|[^A-Za-z0-9])W\s*\d{1,3}(?!\d)/i
const plain = (text: string) =>
  text
    .normalize('NFKC')
    .replace(IGNORABLE, '')
    .replace(/[*_~`\\]/g, '')

/** The app's own checks for each fact-checked claim: every field of the item it stands on. */
function itemChecks(scope: GraphScope, step: WorkflowStep): Map<string, GraphWebCheck[]> {
  const web = scope.web
  const pages = web ? graphWebCheckPagesOf(web.sources, web.outcome) : undefined
  const found = new Map<string, GraphWebCheck[]>()
  for (const id of step.inputs) {
    const output = scope.outputs.get(id)
    const run = output && 'run' in output ? output.run : undefined
    for (const target of run?.targets ?? []) {
      found.set(target.item.key, pages ? checkWebValue(target.item, pages) : [])
    }
  }
  return found
}

/** In a run that reads pages every row carries the app's checks, and whether it rests on a page. */
function withWebChecks(
  scope: GraphScope,
  step: WorkflowStep,
  rows: readonly WorkflowClaimRow[],
  markdown: string,
  written: boolean
): WorkflowClaimRow[] {
  if (!scope.web) {
    return [...rows]
  }
  const items = itemChecks(scope, step)
  const where = `${step.title} (claims table)`
  // Provenance, not spelling: whatever a step page text reaches writes rests on a page.
  const fed = scope.web.reach.has(step.id)
  return rows.map((row) => {
    // Checked after JSON decoding, so an escaped citation is never missed.
    const own = written
      ? (graphWebReportChecks(scope, where, [row.claim, row.evidence], markdown) ?? [])
      : []
    const checks = [...own, ...(row.key ? (items.get(row.key) ?? []) : [])]
    const relies =
      fed || checks.length > 0 || NAMES_A_SOURCE.test(plain(`${row.claim} ${row.evidence}`))
    return { ...row, webChecks: checks, ...(relies ? { reliesOnWeb: true as const } : {}) }
  })
}

/** Lenient like the ranking: a missing or broken table never costs the answer, only a gap. */
export function graphClaimTable(
  scope: GraphScope,
  step: WorkflowStep,
  markdown: string
): { markdown: string; gap?: string; rows?: WorkflowClaimRow[]; appendix?: string } {
  const checks = graphClaimChecks(scope, step)
  const split = splitWorkflowClaimTable(markdown)
  // Rows from the writer and rows the fact-check stands in for are held to the same gate.
  const rows = split.rows
    ? settleWorkflowClaims(withWebChecks(scope, step, split.rows, markdown, true), checks)
    : scope.web
      ? settleWorkflowClaims(
          withWebChecks(scope, step, workflowClaimsFromChecks(checks), markdown, false),
          checks
        )
      : workflowClaimsFromChecks(checks)
  const gap = split.rows
    ? undefined
    : `${step.title} gave no table of claims${rows.length ? ', so the table shows the fact-check as it came back' : ''}.`
  // In a run that reads pages the table is the app's part, kept apart from the model's Markdown.
  const appended = !scope.web && rows.length
  return {
    markdown: appended
      ? [split.markdown.trim(), renderWorkflowClaimTable(rows)].filter(Boolean).join('\n\n')
      : split.markdown,
    ...(gap ? { gap } : {}),
    ...(scope.web && rows.length ? { rows, appendix: renderWorkflowClaimTable(rows) } : {})
  }
}
