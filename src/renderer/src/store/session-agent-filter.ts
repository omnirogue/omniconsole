import { create } from 'zustand'
import type { SessionAgentFilterId } from '@/lib/session-agent-filter'

/** Which agent's conversations the sidebar lists; a view for this window, not a change to any session. */
type SessionAgentFilterState = {
  filter: SessionAgentFilterId | null
  /** Picking the selected agent again clears the filter. */
  toggle: (agent: SessionAgentFilterId) => void
  clear: () => void
}

export const useSessionAgentFilter = create<SessionAgentFilterState>((set, get) => ({
  filter: null,
  toggle: (agent) => set({ filter: get().filter === agent ? null : agent }),
  clear: () => set({ filter: null })
}))
