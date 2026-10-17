/** Click toggles one row; Shift-click selects the visible range from the last clicked row. */
export function toggleArtifactSelection(
  current: ReadonlySet<string>,
  slug: string,
  options: { shift: boolean; anchor: string | null; order: readonly string[] }
): Set<string> {
  const next = new Set(current)
  const from = options.anchor === null ? -1 : options.order.indexOf(options.anchor)
  const to = options.order.indexOf(slug)
  if (options.shift && from !== -1 && to !== -1) {
    const [start, end] = from < to ? [from, to] : [to, from]
    for (const rangeSlug of options.order.slice(start, end + 1)) {
      next.add(rangeSlug)
    }
    return next
  }
  if (next.has(slug)) {
    next.delete(slug)
  } else {
    next.add(slug)
  }
  return next
}

export function artifactHeaderSelectionState(
  checked: ReadonlySet<string>,
  visible: readonly string[]
): boolean | 'indeterminate' {
  const count = visible.filter((slug) => checked.has(slug)).length
  return count === 0 ? false : count === visible.length ? true : 'indeterminate'
}

/** Header box: selects every visible row, or clears them when all already are. */
export function toggleAllArtifactSelection(
  checked: ReadonlySet<string>,
  visible: readonly string[]
): Set<string> {
  const next = new Set(checked)
  const all = visible.length > 0 && visible.every((slug) => checked.has(slug))
  for (const slug of visible) {
    if (all) {
      next.delete(slug)
    } else {
      next.add(slug)
    }
  }
  return next
}
