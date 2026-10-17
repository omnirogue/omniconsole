export type CanonicalWorkerProcessIdentity = {
  pid: number
  started_at: string
  runner_instance: string
}

export type CanonicalWorkerTerminalProof = {
  kind: 'exited' | 'not_started'
  process_identity: CanonicalWorkerProcessIdentity
  process_exited: true
  exit_code: number | null
  process_exit_code?: number | null
  exit_cause?:
    | { kind: 'operator_close' }
    | { kind: 'signaled'; signal: number }
    | { kind: 'exited'; exit_code: number }
  observed_at: string
  launch_gate_closed?: true
}

export type CanonicalWorkerExecution = {
  binding: Record<string, unknown>
  processIdentity: CanonicalWorkerProcessIdentity | null
  phase: 'prepared' | 'released' | 'exited' | 'unknown'
  terminalProof: CanonicalWorkerTerminalProof | null
}
