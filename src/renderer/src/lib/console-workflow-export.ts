import type { ConsoleWorkflowProgress } from '../../../shared/console-workflow-types'
import { layoutConsoleWorkflow } from './console-workflow-layout'

function label(value: string): string {
  return [...value]
    .map((character) =>
      /[a-zA-Z0-9 _./:-]/.test(character) ? character : `#${character.codePointAt(0)};`
    )
    .join('')
}

export function exportConsoleWorkflowView(
  view: ConsoleWorkflowProgress,
  format: 'json' | 'mermaid'
): string {
  if (format === 'json') {
    return JSON.stringify(view, null, 2)
  }
  const jobs = [...view.jobs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const layout = layoutConsoleWorkflow(
    jobs.map((job) => ({ key: job.id, after: job.policy.workflow.after }))
  )
  if (!layout.ok) {
    throw new Error(layout.message)
  }
  const identifiers = new Map(jobs.map((job, index) => [job.id, `n${index}`]))
  const lines = ['flowchart LR']
  for (const job of jobs) {
    const placement = job.machine || job.policy.workflow.placement || 'unassigned'
    lines.push(
      `  ${identifiers.get(job.id)}["${label(`${job.title} · ${job.workflow_state} · ${placement}`)}"]`
    )
  }
  for (const job of jobs) {
    for (const dependency of [...new Set(job.policy.workflow.after)].sort()) {
      const condition = job.policy.workflow.require_merged.includes(dependency) ? '|merged|' : ''
      lines.push(`  ${identifiers.get(dependency)} -->${condition} ${identifiers.get(job.id)}`)
    }
  }
  return `${lines.join('\n')}\n`
}
