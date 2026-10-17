import { create } from 'zustand'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { stewardWasTitles } from '@/lib/steward-title-captions'
import { SESSION_ORGANIZATION_RPC } from '../../../shared/session-organization-change'
import type { OrganizationRecentResult } from '../../../shared/session-organization-readers'

const REFRESH_MS = 60_000

type StewardTitleCaptionsState = {
  /** Session key → its title before the steward's re-title. */
  captions: Record<string, string>
  readAt: number
  reading: boolean
  /** Reads recent title changes at most once a minute, however many rows ask. */
  refresh: () => void
}

export const useStewardTitleCaptions = create<StewardTitleCaptionsState>((set, get) => ({
  captions: {},
  readAt: 0,
  reading: false,
  refresh: () => {
    const now = Date.now()
    if (get().reading || now - get().readAt < REFRESH_MS) {
      return
    }
    set({ reading: true, readAt: now })
    callRuntimeRpc<OrganizationRecentResult>({ kind: 'local' }, SESSION_ORGANIZATION_RPC.recent, {
      kinds: ['title']
    })
      .then((result) => set({ captions: stewardWasTitles(result.entries, Date.now()) }))
      .catch(() => {
        // Why quiet: a caption is advisory; an unreadable history shows none.
      })
      .finally(() => set({ reading: false }))
  }
}))
