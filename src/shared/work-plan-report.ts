import type { SessionChain } from './session-chain-types'
import { readSessionVerdictChecks, type SessionVerdictCheck } from './session-chain-verdict-checks'
import type { SessionOutcome } from './session-outcome-types'
import type { WorkPlanArtifact } from './work-plan-artifact-schema'
import { escapeXml, workPlanTopologySvg } from './work-plan-report-diagram'
import {
  workPlanReportDoneWhen,
  workPlanReportStages,
  type WorkPlanReportRuntime
} from './work-plan-report-topology'

export type { WorkPlanReportRuntime, WorkPlanReportSeatState } from './work-plan-report-topology'

const STYLE = `
:root { color-scheme: light dark; }
body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 24px; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 14px; letter-spacing: .06em; text-transform: uppercase; opacity: .7; margin: 28px 0 8px; }
.done-when { list-style: none; padding: 0; margin: 0; }
.done-when li { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px solid rgba(128,128,128,.2); }
.mark { width: 1.2em; }
.satisfied .mark { color: #1f7a3d; }
.receipt { font-family: ui-monospace, monospace; font-size: 11px; opacity: .65; word-break: break-all; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid rgba(128,128,128,.2); }
th { font-weight: 600; font-size: 12px; opacity: .7; }
.topology { max-width: 100%; height: auto; }
.stage-title { font-size: 12px; font-weight: 600; fill: currentColor; }
.stage-mark { fill: #1f5fa8; }
.seat rect { fill: rgba(128,128,128,.12); stroke: rgba(128,128,128,.5); }
.seat-actor { font-size: 12px; font-weight: 600; fill: currentColor; }
.seat-model { font-size: 11px; fill: currentColor; opacity: .7; }
.seat-done rect { stroke: #1f7a3d; }
.seat-running rect { stroke: #1f5fa8; stroke-width: 2; }
.seat-failed rect { stroke: #a02020; stroke-width: 2; }
.seat-skipped rect { stroke-dasharray: 4 3; }
.flow { stroke: rgba(128,128,128,.6); fill: none; }
.flow-glyph { font-size: 12px; fill: currentColor; opacity: .6; }
.mockup { border: 1px solid rgba(128,128,128,.4); width: 100%; height: 420px; }
footer { margin-top: 32px; font-size: 12px; opacity: .6; }
`.trim()

function escape(value: string): string {
  return escapeXml(value)
}

function section(title: string, body: string): string {
  return body ? `<h2>${escape(title)}</h2>${body}` : ''
}

function bullets(items: string[]): string {
  return items.length ? `<ul>${items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>` : ''
}

function stepRows(plan: WorkPlanArtifact): string {
  return plan.steps
    .map((step) =>
      [
        '<tr>',
        `<td>${step.n}</td>`,
        `<td><strong>${escape(step.title)}</strong><div>${escape(step.detail)}</div></td>`,
        `<td>${escape(step.owner)}</td>`,
        `<td>${step.files.map((file) => `<div class="receipt">${escape(file)}</div>`).join('')}</td>`,
        `<td>${step.dependsOn.join(', ')}</td>`,
        '</tr>'
      ].join('')
    )
    .join('')
}

/**
 * Each Done When line's latest verify result, read only from the gate that line names as its target,
 * so two outcomes that reuse a line id never show each other's result.
 */
function latestChecks(
  chain: SessionChain,
  outcome: SessionOutcome
): Map<string, SessionVerdictCheck> {
  const checks = new Map<string, SessionVerdictCheck>()
  for (const condition of outcome.conditions) {
    const receipt = (chain.verdicts ?? []).findLast((entry) => entry.stepId === condition.target)
    const listed = readSessionVerdictChecks(
      (receipt?.verdict as { checks?: unknown } | null)?.checks
    )
    const check = listed?.find((entry) => entry.id === condition.id)
    if (check) {
      checks.set(condition.id, check)
    }
  }
  return checks
}

function mockupFrames(plan: WorkPlanArtifact): string {
  // sandbox="" is the empty allow-list: no scripts, no forms, no same-origin. A mockup is a
  // drawing, and a drawing the report opens must not be able to act as the report.
  return plan.mockups
    .map(
      (mockup) =>
        `<figure><figcaption>${escape(mockup.title)}</figcaption><iframe class="mockup" sandbox="" referrerpolicy="no-referrer" src="${escape(
          mockup.file
        )}" title="${escape(mockup.title)}"></iframe></figure>`
    )
    .join('')
}

/**
 * View Plan: one self-contained HTML document for one Outcome.
 *
 * Pure and deterministic — same chain, same plan, same `runtime.now` gives the same bytes, so the
 * report can be snapshot-tested and published idempotently. It references nothing off the disk it
 * is written to: no fonts, no scripts, no analytics; the only external documents are the mockups
 * beside it, and those are opened in a fully sandboxed frame.
 *
 * The Outcome and its Done When come FIRST with k/n, because that is what the person is owed; the
 * plan, the live topology and the provenance are how it is being reached.
 */
export function renderWorkPlanHtml(
  chain: SessionChain,
  outcome: SessionOutcome,
  plan: WorkPlanArtifact,
  runtime: WorkPlanReportRuntime
): string {
  const doneWhen = workPlanReportDoneWhen(outcome)
  const satisfied = doneWhen.filter((entry) => entry.satisfied).length
  const stages = workPlanReportStages(chain, runtime, outcome)
  const receipts = doneWhen.filter((entry) => entry.receipt)
  const verdicts = chain.verdicts ?? []
  const checks = latestChecks(chain, outcome)
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escape(outcome.title)} — plan</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<header>',
    `<h1>${escape(outcome.title)}</h1>`,
    `<p>${escape(
      `${outcome.outputKind ?? 'work'} · ${outcome.status} · ${satisfied}/${doneWhen.length} done when · revision ${outcome.revision} · plan v${runtime.planVersion ?? 1}`
    )}</p>`,
    '</header>',
    section(
      'Done when',
      `<ul class="done-when">${doneWhen
        .map(
          (entry) =>
            `<li class="${entry.satisfied ? 'satisfied' : ''}"><span class="mark">${
              entry.satisfied ? '✓' : '·'
            }</span><span>${escape(entry.label)}${
              checks.has(entry.id)
                ? `<div class="receipt">${escape(
                    `${checks.get(entry.id)!.status.toUpperCase()} — ${checks.get(entry.id)!.evidence}`
                  )}</div>`
                : ''
            }${entry.receipt ? `<div class="receipt">${escape(entry.receipt)}</div>` : ''}</span></li>`
        )
        .join('')}</ul>`
    ),
    section('Topology', workPlanTopologySvg(stages)),
    section('Summary', `<p>${escape(plan.summary)}</p>`),
    section('Assumptions', bullets(plan.assumptions)),
    section(
      'Steps',
      `<table><thead><tr><th>#</th><th>Step</th><th>Owner</th><th>Files</th><th>After</th></tr></thead><tbody>${stepRows(
        plan
      )}</tbody></table>`
    ),
    section('Risks', bullets(plan.risks)),
    section('Open questions', bullets(plan.openQuestions)),
    section('Mockups', mockupFrames(plan)),
    section(
      'Provenance',
      `<ul>${[
        ...receipts.map(
          (entry) =>
            `<li>${escape(entry.label)}<div class="receipt">${escape(entry.receipt!)} · ${escape(
              new Date(entry.verifiedAt!).toISOString()
            )}</div></li>`
        ),
        ...verdicts.map(
          (receipt) =>
            `<li>${escape(`verdict on ${receipt.stepId}${receipt.skipped ? ' (skipped)' : ''}`)}<div class="receipt">${escape(
              `${receipt.consumptionKey} · attempt ${receipt.attemptId} · ${new Date(receipt.consumedAt).toISOString()}`
            )}</div></li>`
        )
      ].join('')}</ul>`
    ),
    `<footer>${escape(
      `${plan.title}${plan.estimate ? ` · ${plan.estimate}` : ''} · chain ${chain.id} · rendered ${new Date(runtime.now).toISOString()}`
    )}</footer>`,
    '</body>',
    '</html>'
  ]
    .filter(Boolean)
    .join('\n')
}
