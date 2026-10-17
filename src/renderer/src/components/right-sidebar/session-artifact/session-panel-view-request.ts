import { create } from 'zustand'
import type { SessionWorkTab } from './session-work-tabs'

/** A Session work tab another surface can open on the person's click. */
export type SessionPanelRequestedView = SessionWorkTab

type SessionPanelViewRequest = {
  /** The view to show next; taken (cleared) by the panel that shows it. */
  view: SessionPanelRequestedView | null
  /** Bumped on every request, so the panel opens again even for the same view. */
  revision: number
}

export const useSessionPanelViewRequest = create<SessionPanelViewRequest>(() => ({
  view: null,
  revision: 0
}))

/**
 * Opens the right panel's Session work on `view` for the conversation on screen. Only ever on a
 * click: the panel starts collapsed and nothing opens it by itself.
 */
export function requestSessionPanelView(view: SessionPanelRequestedView): void {
  useSessionPanelViewRequest.setState((current) => ({ view, revision: current.revision + 1 }))
}

/** The requested view, once: the panel that shows it clears the request. */
export function takeSessionPanelViewRequest(): SessionPanelRequestedView | null {
  const { view } = useSessionPanelViewRequest.getState()
  if (view) {
    useSessionPanelViewRequest.setState({ view: null })
  }
  return view
}
