// Shapes of the Omni Console BFF GET endpoints the FleetBridge polls. These
// mirror bff/omni_bff/app.py (loopback, GET-only, no auth cookie needed). Every
// field is optional/tolerant — the BFF degrades gracefully (empty lists, STALE
// state) and we never fabricate what it doesn't send.

type FleetSnapshotValue =
  | string
  | number
  | boolean
  | null
  | FleetSnapshotValue[]
  | { [key: string]: FleetSnapshotValue }

export type FleetSession = {
  id: string
  machine_id?: string | null
  agent_name?: string | null
  agent_profile?: string | null
  agent_status?: string | null
  attention_state?: string | null
  source?: string | null
  kind?: string | null
  personal?: boolean
  task_summary?: string | null
  parent_session?: string | null
  employee_id?: string | null
  cwd?: string | null
  error?: string | null
  cost_usd?: number | null
  created_at?: string | null
  heartbeat_at?: string | null
}

export type SessionsResponse = {
  sessions: FleetSession[]
  truncated?: boolean
}

export type DispatchNode = {
  machine_id?: string | null
  hostname?: string | null
  os?: string | null
  labels?: string[] | null
  max_concurrent?: number | null
  in_flight?: number | null
  drain?: number | null
  last_seen_at?: string | null
  load_ratio?: number | null
  role?: string | null
}

export type DispatchResponse = {
  ok?: boolean
  reason?: string | null
  generated_at?: string | null
  pool_available?: boolean
  dispatchers?: DispatchNode[]
  runners?: DispatchNode[]
  depth?: Record<string, number | null> | null
  capacity?: Record<string, number | null> | null
  refusals_24h?: Record<string, number | null> | null
}

export type HealthEvent = {
  id?: string | number | null
  source?: string | null
  severity?: string | null
  kind?: string | null
  rule?: string | null
  summary?: string | null
  message?: string | null
  detail?: string | null
  machine_id?: string | null
  detected_at?: string | number | null
  needs_repair?: boolean | null
}

export type HealthResponse = {
  state?: string | null
  sources?: Record<string, string | null> | null
  events?: HealthEvent[]
  summary?: FleetSnapshotValue
  alerts?: FleetSnapshotValue[]
  reason?: string | null
}

export type UsageWindow = {
  kind?: string | null
  label?: string | null
  percent?: number | null
  severity?: string | null
  resets_at?: string | null
  window_minutes?: number | null
  scope_model?: string | null
  is_active?: boolean | null
}

export type UsageAccount = {
  provider?: string | null
  root?: string | null
  account_key?: string | null
  email?: string | null
  plan?: string | null
  available?: boolean
  reason?: string | null
  quota_window?: string | null
  stale?: boolean | null
  fetched_at?: string | null
  windows?: UsageWindow[]
  provider_limit_state?: string | null
  source?: string | null
}

export type UsageResponse = {
  accounts?: UsageAccount[]
  hub_usage?: FleetSnapshotValue
  generated_at?: string | null
}
