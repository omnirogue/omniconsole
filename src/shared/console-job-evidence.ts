export type ConsoleJobEvidenceKind = 'input' | 'provider_event' | 'output' | 'status'

export type ConsoleJobLogRequest = { jobId: string; attempt?: number }

export type ConsoleJobEvidenceRequest = {
  jobId: string
  attempt?: number
  leaseGeneration?: number
  after?: number
  limit?: number
  kind?: ConsoleJobEvidenceKind
}

export type ConsoleJobEvidenceEntry = {
  id: number
  kind: ConsoleJobEvidenceKind
  text: string
  at: string
  record_id?: number
  part?: number
  final?: boolean
}

export type ConsoleJobEvidencePage = {
  job_id: string
  attempt: number
  lease_generation: number
  host: string | null
  session_id: string | null
  provider: string | null
  entries: ConsoleJobEvidenceEntry[]
  next_after: number
  has_more: boolean
  /** Only the runner's acknowledged final upload proves the capture is complete. */
  complete: boolean
}

/** Legacy saved output; the server keeps at most 262,144 characters per attempt. */
export type ConsoleJobLog = {
  job_id: string
  attempt: number
  host: string | null
  log: string
  at: string
}
