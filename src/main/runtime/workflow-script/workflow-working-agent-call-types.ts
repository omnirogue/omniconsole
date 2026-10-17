export type WorkingAgentCallRow = {
  execution_id: string
  call_id: string
  run_id: string
  task_id: string
  start_request_id: string
  dispatch_id: string | null
  workspace_id: string
  child_worktree_id: string | null
  input_digest: string
  source_base: string
  source_diff_digest: string
  capability_revision: string
  schema_json: string
  schema_digest: string
  semantic_json: string
  semantic_digest: string
  result_json: string | null
  result_digest: string | null
  artifact_digest: string | null
  result_revision: number
  state: 'prepared' | 'starting' | 'running' | 'accepted' | 'failed' | 'unverifiable'
}
