import { createContext, useContext } from 'react'

const NO_PREVIEWS: ReadonlyMap<string, string> = new Map()

/**
 * While the sidebar filter is typed, the passage of each listed session's conversation that
 * matched it, by row key. Rows outside a sidebar (the Grid, hover cards) see none.
 */
export const SessionSearchPreviewContext = createContext<ReadonlyMap<string, string>>(NO_PREVIEWS)

/** True while the sidebar filter is typed: rows then draw on one line, as search results. */
export const SessionSearchActiveContext = createContext(false)

export function useSessionSearchActive(): boolean {
  return useContext(SessionSearchActiveContext)
}

export function useSessionSearchPreview(rowKey: string): string | null {
  return useContext(SessionSearchPreviewContext).get(rowKey) ?? null
}

export function emptySessionSearchPreviews(): ReadonlyMap<string, string> {
  return NO_PREVIEWS
}
