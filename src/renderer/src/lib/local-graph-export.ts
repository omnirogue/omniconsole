import { layoutConsoleWorkflow } from './console-workflow-layout'
import type { LocalGraphView } from './local-graph-view'

/**
 * The same two exports Lane 3 offers for a server workflow, for a graph this desktop
 * ran itself. Identifiers and states are the stored ids, never translated labels: the
 * file is read by other tools, and a localized state would make it unusable.
 */
export type LocalGraphExportFormat = 'json' | 'mermaid'

function label(value: string): string {
  return [...value]
    .map((character) =>
      /[a-zA-Z0-9 _./:-]/.test(character) ? character : `#${character.codePointAt(0)};`
    )
    .join('')
}

export function exportLocalGraphView(view: LocalGraphView, format: LocalGraphExportFormat): string {
  if (format === 'json') {
    return JSON.stringify(view, null, 2)
  }
  const layout = layoutConsoleWorkflow(
    view.nodes.map((node) => ({ key: node.id, after: node.after }))
  )
  if (!layout.ok) {
    throw new Error(layout.message)
  }
  const identifiers = new Map(view.nodes.map((node, index) => [node.id, `n${index}`]))
  const lines = ['flowchart LR']
  for (const node of view.nodes) {
    const folder = node.childWorkspaceName
      ? `${node.workspacePath} (${node.childWorkspaceName})`
      : node.workspacePath
    lines.push(
      `  ${identifiers.get(node.id)}["${label(`${node.id} · ${node.state} · ${node.placement} · ${folder}`)}"]`
    )
  }
  for (const node of view.nodes) {
    for (const dependency of [...new Set(node.after)].sort()) {
      const from = identifiers.get(dependency)
      if (from) {
        lines.push(`  ${from} --> ${identifiers.get(node.id)}`)
      }
    }
  }
  for (const loop of view.loops) {
    const from = identifiers.get(loop.from)
    const to = identifiers.get(loop.to)
    if (from && to) {
      // Dotted, so a repeat edge is never mistaken for a dependency the layout obeys.
      lines.push(`  ${from} -.->|${label(`round ${loop.round}/${loop.maxRounds}`)}| ${to}`)
    }
  }
  for (const node of view.nodes) {
    for (const file of node.producedFiles) {
      lines.push(`  %% produced by ${node.id}: ${file}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** Downloadable file name for one exported graph. */
export function localGraphExportFileName(
  view: LocalGraphView,
  format: LocalGraphExportFormat
): string {
  return `${view.source}-${view.id}.${format === 'json' ? 'json' : 'mmd'}`
}
