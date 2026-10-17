import type { PlannedItem } from '../../shared/session-prep-types'
import { mergePlannedChoices } from './session-prep-choices'
import { SessionPrepHostError } from './session-prep-execution-host'

/**
 * A stated order ("schema first, then the three UIs") runs as ONE session that does the parts in
 * that order: the same agent then builds each part on the one before. Items with no stated order
 * stay separate and run in parallel. Why not separate sessions: a launched session has no
 * dependable "finished" signal to start the next one on.
 */
export function foldOrderedItems(items: PlannedItem[]): PlannedItem[] {
  if (!items.some((item) => item.after?.length)) {
    return items
  }
  const parent = items.map((_, index) => index)
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!
      index = parent[index]!
    }
    return index
  }
  items.forEach((item, index) => {
    for (const before of item.after ?? []) {
      const [a, b] = [find(before), find(index)]
      if (a !== b) {
        parent[Math.max(a, b)] = Math.min(a, b)
      }
    }
  })
  const groups = new Map<number, number[]>()
  items.forEach((_, index) => {
    const root = find(index)
    groups.set(root, [...(groups.get(root) ?? []), index])
  })
  return [...groups.values()].map((members) => {
    if (members.length === 1) {
      const { after: _after, ...alone } = items[members[0]!]!
      return alone
    }
    // Why: `after` only points at earlier indexes, so index order is a valid execution order.
    const parts = members.map((index) => items[index]!)
    const hosts = new Set(parts.map((part) => part.choices?.host?.toLowerCase()).filter(Boolean))
    if (hosts.size > 1) {
      throw new SessionPrepHostError(
        'Ordered work names different Macs. Prepare each host separately so its order can be supervised.'
      )
    }
    const [first, ...rest] = parts
    const choices = mergePlannedChoices(parts)
    return {
      title: truncateTitle(parts.map((part) => part.title).join(' → ')),
      ask: [
        first!.ask,
        ...rest.map((part) => {
          // Why: the folded session runs in the first part's repository; name any other one.
          const where =
            part.repoHint && part.repoHint !== first!.repoHint ? ` (in ${part.repoHint})` : ''
          return `Then, once that is done${where}: ${part.ask}`
        })
      ].join('\n'),
      anchor: first!.anchor,
      direct: false,
      changesCode: parts.some((part) => part.changesCode),
      ...(first!.repoHint ? { repoHint: first!.repoHint } : {}),
      ...(choices ? { choices } : {})
    }
  })
}

function truncateTitle(title: string): string {
  return title.length <= 60 ? title : `${title.slice(0, 59).trimEnd()}…`
}
