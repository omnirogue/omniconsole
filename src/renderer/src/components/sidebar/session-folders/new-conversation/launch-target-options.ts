export type LaunchTarget = { kind: 'workspace'; worktreeId: string } | { kind: 'work-root' }

export type TargetOption = {
  target: LaunchTarget
  key: string
  name: string
  detail: string
  kind: 'repo' | 'folder' | 'root'
  /** Folder-first declutter: where this row lives in the list (top level unless grouped). */
  placement: { kind: 'top-level' } | { kind: 'under'; parentKey: string } | { kind: 'existing' }
}

/** Top-level rows, children grouped under their parent row, and orphans; the current target always stays top-level. */
export function partitionLaunchTargetOptions(
  options: readonly TargetOption[],
  selectedKey: string
): {
  topLevel: TargetOption[]
  childrenByParentKey: Map<string, TargetOption[]>
  existing: TargetOption[]
} {
  const topLevelKeys = new Set(
    options.filter((option) => option.placement.kind === 'top-level').map((option) => option.key)
  )
  const topLevel: TargetOption[] = []
  const childrenByParentKey = new Map<string, TargetOption[]>()
  const existing: TargetOption[] = []
  for (const option of options) {
    const { placement } = option
    if (placement.kind === 'top-level' || option.key === selectedKey) {
      topLevel.push(option)
    } else if (placement.kind === 'under' && topLevelKeys.has(placement.parentKey)) {
      const list = childrenByParentKey.get(placement.parentKey) ?? []
      list.push(option)
      childrenByParentKey.set(placement.parentKey, list)
    } else {
      existing.push(option)
    }
  }
  return { topLevel, childrenByParentKey, existing }
}
