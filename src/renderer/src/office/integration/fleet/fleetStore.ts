// @ts-nocheck
import { create } from 'zustand'
import type { DispatchResponse, HealthResponse, FleetSession, UsageAccount } from './fleetTypes'

// Raw fleet snapshot the FleetBridge writes on every poll. The interface panels
// that need our real numbers (ProjectView's provider-usage section, the header
// connection dot) read from here. The 3D sim + Kanban + action log read the
// coreStore, which the bridge also populates.
// Per-slice load state so each panel can fill in on its own — a slow/dead hub
// degrades one section to an honest marker instead of gating the whole UI.
export type SliceStatus = 'loading' | 'ready' | 'error'

type FleetState = {
  connected: boolean
  lastError: string | null
  lastUpdated: number | null
  sessions: FleetSession[]
  usage: UsageAccount[]
  dispatch: DispatchResponse | null
  health: HealthResponse | null
  // Hub-dependent slices (proxied through the estate hub) load independently of
  // the local, fast /api/sessions feed that drives first paint.
  usageStatus: SliceStatus
  dispatchStatus: SliceStatus
  set: (patch: Partial<FleetState>) => void
}

export const useFleetStore = create<FleetState>()((set) => ({
  connected: false,
  lastError: null,
  lastUpdated: null,
  sessions: [],
  usage: [],
  dispatch: null,
  health: null,
  usageStatus: 'loading',
  dispatchStatus: 'loading',
  set: (patch) => set(patch)
}))
