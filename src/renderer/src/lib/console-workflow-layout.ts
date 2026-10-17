import { translate } from '@/i18n/i18n'

type LayerNode = { key: string; after?: readonly string[] }

export type ConsoleWorkflowLayout =
  | { ok: true; columns: string[][] }
  | { ok: false; message: string }

/** Presentation only: dependencies and readiness remain server-owned. */
export function layoutConsoleWorkflow(nodes: readonly LayerNode[]): ConsoleWorkflowLayout {
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  if (byKey.size !== nodes.length) {
    return {
      ok: false,
      message: translate(
        'consoleWorkflows.graphDuplicateStageKeys',
        'The server graph has duplicate stage keys.'
      )
    }
  }
  const remaining = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const node of nodes) {
    const after = [...new Set(node.after ?? [])]
    remaining.set(node.key, after.length)
    for (const key of after) {
      if (!byKey.has(key)) {
        return {
          ok: false,
          message: `${translate('consoleWorkflows.graphMissingStage', 'The server graph references missing stage')} ${key}.`
        }
      }
      const children = dependents.get(key) ?? []
      children.push(node.key)
      dependents.set(key, children)
    }
  }
  const columns: string[][] = []
  let ready = [...remaining]
    .filter(([, count]) => count === 0)
    .map(([key]) => key)
    .sort()
  let visited = 0
  while (ready.length) {
    columns.push(ready)
    visited += ready.length
    const next: string[] = []
    for (const key of ready) {
      for (const child of dependents.get(key) ?? []) {
        const count = remaining.get(child)! - 1
        remaining.set(child, count)
        if (count === 0) {
          next.push(child)
        }
      }
    }
    ready = next.sort()
  }
  return visited === nodes.length
    ? { ok: true, columns }
    : {
        ok: false,
        message: translate(
          'consoleWorkflows.graphDependencyCycle',
          'The server graph contains a dependency cycle.'
        )
      }
}
