// @ts-nocheck
// Thin client for the Omni Console jobs endpoints, shared by the FleetBridge
// poller (reads) and the Kanban detail panel (writes). All same-origin, behind
// the loopback P0 floor: GET needs nothing, POST/PATCH ride the SameSite session
// cookie the console already holds (credentials:'same-origin' sends it).
import { apiFetch } from '../../lib/apiBase'
import { useJobsStore } from './jobsStore'
import type { Job, JobsResponse } from './jobsTypes'

const REQ_TIMEOUT_MS = 8000

async function req<T>(path: string, init?: RequestInit): Promise<T | null> {
  const ctrl = new AbortController()
  const to = window.setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
  try {
    const doFetch = () =>
      apiFetch(path, {
        credentials: 'same-origin',
        signal: ctrl.signal,
        ...init,
        headers: { accept: 'application/json', ...init?.headers }
      })
    let res = await doFetch()
    // A BFF restart rotates the SameSite session cookie under an open tab;
    // mutations then 403 with tag "no-session". Re-mint via GET / and retry ONCE.
    if (res.status === 403) {
      const parsed = await res
        .clone()
        .json()
        .catch(() => null)
      if (parsed?.tag === 'no-session') {
        await apiFetch('/', { cache: 'no-store', credentials: 'same-origin' })
        res = await doFetch()
      }
    }
    if (!res.ok) {
      return null
    }
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    window.clearTimeout(to)
  }
}

export async function fetchJobs(): Promise<JobsResponse | null> {
  return req<JobsResponse>('/api/jobs')
}

/** Poll GET /api/jobs and fold the result into the jobs store (honest markers on
 *  failure — an unreachable BFF sets connected=false, never a fabricated board). */
export async function refreshJobs(): Promise<void> {
  const res = await fetchJobs()
  if (!res) {
    useJobsStore.getState().set({
      connected: false,
      lastError: 'BFF unreachable (is the loopback service running?)'
    })
    return
  }
  useJobsStore.getState().set({
    jobs: Array.isArray(res.jobs) ? res.jobs : [],
    machineId: res.machine_id ?? null,
    connected: res.ok !== false,
    lastError: res.reason ?? null,
    lastUpdated: Date.now()
  })
}

function writeJson(path: string, method: string, body: unknown): Promise<Job | null> {
  return req<Job>(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })
}

export function createJob(body: Partial<Job>): Promise<Job | null> {
  return writeJson('/api/jobs', 'POST', body)
}

export function patchJob(jobId: string, body: Partial<Job>): Promise<Job | null> {
  return writeJson(`/api/jobs/${encodeURIComponent(jobId)}`, 'PATCH', body)
}

export function prioritizeJob(jobId: string, to: 'top' | number = 'top'): Promise<Job | null> {
  return writeJson(`/api/jobs/${encodeURIComponent(jobId)}/prioritize`, 'POST', { to })
}

export function bindJob(jobId: string, sessionRef: string): Promise<unknown> {
  return req(`/api/jobs/${encodeURIComponent(jobId)}/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_ref: sessionRef })
  })
}
