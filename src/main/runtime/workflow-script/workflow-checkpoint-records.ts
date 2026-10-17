export type WorkflowCallRecord = {
  input_digest: string
  result_json: string | null
  result_digest: string | null
  quarantined: number
}

export type WorkflowExecutionRecord = {
  id: string
  snapshot_json: string
  snapshot_digest: string
  fence: number
  state: string
  attempt_limit: number
  call_limit: number
  budget_limit: number
  budget_reserved: number
}
