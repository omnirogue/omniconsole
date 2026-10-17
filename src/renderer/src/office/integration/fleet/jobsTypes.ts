// @ts-nocheck
// Shape of the Omni Console BFF /api/jobs endpoints the FleetBridge polls and the
// Kanban writes. Mirrors bff/omni_bff/jobs_proxy.py (loopback, GET public; POST/
// PATCH need the SameSite session cookie the console already holds). Every field
// is tolerant — the BFF degrades gracefully (honest empty board) and we never
// fabricate what it doesn't send.

export type JobStatus = 'scheduled' | 'on_hold' | 'in_progress' | 'done'

export type JobSession = {
  session_ref?: string | null
  agent_name?: string | null
  agent_status?: string | null
  machine_id?: string | null
}

export type Job = {
  job_id: string
  title: string
  detail?: string | null
  status: string
  priority?: number | null
  owner?: string | null
  // 'manual' | 'dispatch' | 'derived' — derived jobs are styled faintly and are
  // read-only (they stand for a running session, not a stored job row).
  source?: string | null
  created_at?: number | null
  updated_at?: number | null
  sessions?: JobSession[]
}

export type JobsResponse = {
  ok?: boolean
  machine_id?: string | null
  jobs?: Job[]
  degraded?: boolean
  reason?: string | null
}
