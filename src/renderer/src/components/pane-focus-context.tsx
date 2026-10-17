import { createContext, useContext } from 'react'

export type PaneFocus = { visible: boolean; focused: boolean }

/** Without an embedding pane, the mounted page owns its keyboard shortcuts. */
export const PaneFocusContext = createContext<PaneFocus>({ visible: true, focused: true })

export function usePaneFocus(): PaneFocus {
  return useContext(PaneFocusContext)
}

export function usePaneKeyboardEnabled(): boolean {
  const { visible, focused } = usePaneFocus()
  return visible && focused
}
