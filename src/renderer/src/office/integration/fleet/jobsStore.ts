// @ts-nocheck
import { create } from 'zustand'
import type { Job } from './jobsTypes'

// The jobs board snapshot the FleetBridge writes on every /api/jobs poll. The
// JobsKanbanPanel + the Header job-count read from here. Kept separate from the
// sessions-driven fleetStore/coreStore: the Kanban is now JOB-based while the 3D
// characters + activity log stay driven by sessions.
type JobsState = {
  jobs: Job[]
  connected: boolean
  machineId: string | null
  lastError: string | null
  lastUpdated: number | null
  set: (patch: Partial<JobsState>) => void
}

export const useJobsStore = create<JobsState>()((set) => ({
  jobs: [],
  connected: false,
  machineId: null,
  lastError: null,
  lastUpdated: null,
  set: (patch) => set(patch)
}))
