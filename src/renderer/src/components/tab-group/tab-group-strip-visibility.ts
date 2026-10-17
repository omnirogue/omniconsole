/** A conversation keeps the same chrome in Chat and Terminal, but only when
 *  chat can actually render there — Chat UI must be on and no client-hosted
 *  browser rows may depend on this strip. Independent of the tab's own view
 *  mode so a switch never mounts or unmounts the strip. */
export function shouldHideTabGroupStrip({
  tabCount,
  activeTabContentType,
  hasAgent,
  nativeChatUiEnabled = true,
  hasClientHostedRows = false
}: {
  tabCount: number
  activeTabContentType: string | null | undefined
  hasAgent: boolean
  // Deliberately not read: the decision must stay the same across Chat and
  // Terminal so a switch never mounts or unmounts the strip. Callers/tests may
  // still pass it to document that independence.
  activeTabViewMode?: string
  /** Settings > Experimental > Chat UI. Defaults true to keep existing
   *  single-arg call sites/tests (which assume Chat UI is on) unchanged. */
  nativeChatUiEnabled?: boolean
  /** True when this group owns the worktree's client-hosted browser rows,
   *  which render only inside the strip. */
  hasClientHostedRows?: boolean
}): boolean {
  return (
    tabCount === 1 &&
    activeTabContentType === 'terminal' &&
    hasAgent &&
    nativeChatUiEnabled &&
    !hasClientHostedRows
  )
}
