/**
 * One authoritative per-account capacity view for Claude and Codex.
 *
 * Why: Settings, the status bar and the "+" launcher each read the same raw
 * `RateLimitState` with their own classifier, and the raw state cannot say which
 * login a reading came from or whether OmniConsole can still use that login.
 * Main builds these rows (it alone knows which credential works and which
 * reading belongs to whom) and ships them inside `RateLimitState.accountCapacity`,
 * so every surface renders the same rows and moves together on each
 * `rateLimits:update` push.
 */
export type CapacityProvider = 'claude' | 'codex'

export type CapacityWindow = {
  /** 0–100, already clamped. */
  remainingPercent: number
  /** Unix ms; null when the provider did not report a reset. */
  resetsAt: number | null
  /** 300 = 5 hours, 10080 = 7 days. */
  windowMinutes: number
}

/**
 * - `ready`: a working login and a current reading with room left.
 * - `limited`: a working login, but a window is exhausted until `limitedUntil`.
 * - `usable`: a working login without a current reading (the usage endpoint
 *   asked us to wait, or the CLI refreshes the token on its next use). Launches work.
 * - `checking`: the first reading is in flight and nothing is known yet.
 * - `signed-out`: no working login for this account exists on this machine.
 */
export type AccountCapacityState = 'ready' | 'limited' | 'usable' | 'checking' | 'signed-out'

export type AccountSignedOutReason = 'no-login' | 'revoked' | 'expired'

export type AccountCapacityRow = {
  provider: CapacityProvider
  /** Managed account id; null for the System login. */
  accountId: string | null
  /** Stable key for UI and defaults: `managed:<id>` or `system`. */
  choiceId: string
  email: string | null
  /** Workspace or organization label when one email has several (Codex team vs pro). */
  detail: string | null
  planType?: string | null
  isDefault: boolean
  isSystem: boolean
  /** 5-hour window; null when the account has none (Codex Pro reports weekly only). */
  fiveHour: CapacityWindow | null
  weekly: CapacityWindow | null
  /** Claude only: the Fable-only weekly window. */
  fableWeekly: CapacityWindow | null
  /** Provider-reported redeemable resets; absent/null means unknown, not zero. */
  availableResetCredits?: number | null
  state: AccountCapacityState
  signedOutReason: AccountSignedOutReason | null
  /** For `limited`: when the exhausted window resets. */
  limitedUntil: number | null
  /** Unix ms of the reading shown; null when there is none. */
  readingAt: number | null
  /** Set while the usage endpoint asked us to wait; the windows shown are the last known ones. */
  readingPausedUntil: number | null
  /** Where the working login lives, for display only, e.g. "~/.claude-account-5". */
  sourceLabel: string | null
  /**
   * Environment that launches exactly this account (`CLAUDE_CONFIG_DIR` or
   * `CODEX_HOME`); pass it as `launchEnv`. Null when the account cannot launch here.
   */
  launchEnv: Record<string, string> | null
}

export type ProviderAccountCapacitySnapshot = {
  claude: AccountCapacityRow[]
  codex: AccountCapacityRow[]
  /** Unix ms when main built the snapshot. */
  builtAt: number
}

export const SYSTEM_ACCOUNT_CHOICE_ID = 'system'

export function accountCapacityChoiceId(accountId: string | null): string {
  return accountId === null ? SYSTEM_ACCOUNT_CHOICE_ID : `managed:${accountId}`
}
