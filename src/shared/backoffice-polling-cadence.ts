// The closed-project sweep exists only until GET /api/estate/peers/summary?since=<cursor> lands.
export const PEER_SWEEP_INTERVAL_MS = 10 * 60_000

/** Desktop read cadence; timers never count as user activity. */
export const BACKOFFICE_POLLING = {
  maxConcurrentRefreshes: 2,
  peerMaxInFlight: 1,
  graphMaxInFlight: 1,
  graphScopeCacheLimit: 4,
  peerOpenMaxPages: 4,
  focusedMs: 60_000,
  hiddenMs: 5 * 60_000,
  idleStopMs: 15 * 60_000,
  requestTimeoutMs: 15_000
} as const
