import type { CleanupKeepReason } from './automatic-session-cleanup-protection'
/**
 * Idle auto-close and agent hibernation share one set of keeps and one log (Sal, 2026-09-30:
 * "yes 30 minutes"). Every decision is one line in `<userData>/session-actions.jsonl` with actor
 * `hibernation`, its rule id and the evidence it read.
 *
 * Which rule governs agent sleep (R1). There is one planner and one coordinator
 * (agent-hibernation-coordinator.ts), so a done agent has exactly one path to sleep, and
 * `idleAutoCloseMode` governs whether that path acts, the opt-in hibernation included:
 * - the idle window is `idleAutoCloseMinutes` (default 30); with `experimentalAgentHibernation`
 *   on it is the longer of that and `agentHibernationIdleMs`, so a done agent never sleeps sooner
 *   than either setting allows (hibernation also plans runtime-environment panes; they stay awake
 *   while this computer cannot read their Stage A1 state or prove their agent);
 * - R1 sleeps only an agent main proves holds its terminal and reads idle (`agentForeground`);
 * - R2 (idle shells) and R3 (hidden browser pages) use `idleAutoCloseMinutes`. R2 never closes a
 *   tab and never stops a PTY alone: it acts only on a whole non-active workspace whose every tab is
 *   an idle bare shell and which holds no agent state, and puts it to sleep the way a person's Sleep
 *   does (G6): each shell stops keeping its history, tabs and layouts stay, and opening the
 *   workspace restores each shell in place with its scrollback (the daemon's 5,000 restore rows)
 *   into a fresh shell at the same cwd. A workspace with any other tab is left alone.
 *
 * Modes, for every rule: `shadow` (default) writes what each rule would do and acts on nothing,
 * hibernation included; `on` acts, and only while the restore flood guard is on
 * (`restoreFloodGuard`, default true), else it stays a shadow and says why; `off` is the kill
 * switch for all of it, hibernation included. A change of mode stops a drain already running.
 *
 * Every rule keeps a pane, re-read immediately before each single action (G4), when:
 * G1 it holds an open ask (Stage A1 says awaiting-user or waiting-for-yes, or its last reply ends
 *    with "?" or lists two or more numbered lines); G2 a person touched it in the last 10 minutes
 *    (revealed its tab, attached, typed); G3 it is on screen, by the pane's own `isVisibleRef`.
 * G5: nothing here gates a 'quit' or 'live' record of a mid-task agent (interrupted restore).
 */

export const IDLE_AUTO_CLOSE_MODES = ['shadow', 'on', 'off'] as const
export type IdleAutoCloseMode = (typeof IDLE_AUTO_CLOSE_MODES)[number]

export const DEFAULT_IDLE_AUTO_CLOSE_MODE: IdleAutoCloseMode = 'shadow'
export const DEFAULT_IDLE_AUTO_CLOSE_MINUTES = 30
export const MIN_IDLE_AUTO_CLOSE_MINUTES = 5
export const MAX_IDLE_AUTO_CLOSE_MINUTES = 24 * 60

const MS_PER_MINUTE = 60 * 1000

/** G2: a reveal, a person attaching or a keystroke this recent keeps a pane. */
export const IDLE_RECENT_TOUCH_MS = 10 * MS_PER_MINUTE
/** A pane woken this soon after it was put to sleep is exempt for the rest of the app session. */
export const HIBERNATION_THRASH_WINDOW_MS = 30 * MS_PER_MINUTE

export const IDLE_RULE = {
  R1: 'idle.R1.sleep-done-agent',
  R2: 'idle.R2.sleep-idle-shell-workspace',
  R3: 'idle.R3.discard-hidden-page',
  /** Not a rule: a slept pane came back, whatever woke it. */
  WAKE: 'hibernation.wake',
  /**
   * A record the old hibernation wrote, given the open-on-click shape once per app session; gated
   * like the rules (only `on` rewrites, shadow logs) and kept by G1-G3.
   */
  NORMALIZE: 'hibernation.normalize-record',
  /** Not a rule: one line counting why panes were kept. */
  SUMMARY: 'idle.summary'
} as const
export type IdleRuleId = (typeof IDLE_RULE)[keyof typeof IDLE_RULE]

export const HIBERNATION_AUDIT_ACTIONS = [
  'hibernation.sleep',
  'hibernation.wake',
  'hibernation.drop-stale-done',
  'hibernation.normalize-record',
  'idle.sleep-shells',
  'idle.discard-page',
  'idle.summary'
] as const
export type HibernationAuditAction = (typeof HIBERNATION_AUDIT_ACTIONS)[number]

export type HibernationEvidence = Record<string, string | number | boolean | null>

export type HibernationAudit = {
  rule: IdleRuleId
  /** `shadow` never acts; `on` acted (or tried to). */
  mode: 'shadow' | 'on'
  outcome: 'would' | 'done' | 'failed' | 'kept'
  evidence: HibernationEvidence
}

/** Why a rule left a pane, tab or page alone. Each guard has its own code so the log can count. */
export type IdleKeepReason =
  | CleanupKeepReason
  /** G1 */
  | 'open-ask'
  /** G2 */
  | 'recent-touch'
  /** G3 */
  | 'visible'
  /** G5 */
  | 'interrupted-restore'
  /** Stage A1 reads it working, queued or provider-limited, or its Keep going is on. */
  | 'not-idle'
  /** Its own plan waits on an event (a Jira reply, a session's result): kept until it arrives. */
  | 'pending-wait'
  /** A reading failed: unknown means keep. */
  | 'unreadable'
  /** Woken within 30 minutes of its last sleep; exempt for the rest of the app session. */
  | 'thrash-exempt'
  /** Its terminal's processes could not be read, or main could not prove the agent holds it. */
  | 'process-unknown'
  /**
   * Something other than its agent holds the terminal (another program, a suspended job, a shell
   * with children): R1 neither sleeps it nor drops its done entry.
   */
  | 'foreground-not-agent'
  /** Back at its bare login shell (no children): the done entry was stale (R1 drops it). */
  | 'shell-foreground'

export const IDLE_AUTO_CLOSE_RPC = {
  record: 'idleAutoClose.record',
  keepReadings: 'idleAutoClose.keepReadings'
} as const

/** main's reading of one pane for G1 (`idleAutoClose.keepReadings`). */
export type IdleKeepReading = {
  paneKey: string
  /** The sidebar lists a conversation for the pane. */
  listed: boolean
  /** The Stage A1 state (`omni session list`), when one was read. */
  state: string | null
  /** A reply this host holds for it ends with a question or lists numbered questions. */
  openAsk: boolean
  keepGoing: boolean
  /**
   * main's pid-grade proof (`observeSession`'s `agentForeground`) that the row's own agent kind
   * holds the terminal's foreground: true proven, false disproven (another program, the bare
   * shell, a suspended job), null unread. Only true lets R1 sleep a pane.
   */
  agentForeground: boolean | null
  /** The label of an unanswered event wait in its own plan ("Iris replies on OMR-93"); kept while set. */
  waitingOn?: string
  /** The reading itself failed (keep). */
  failed?: true
}

const ASKING_STATES: ReadonlySet<string> = new Set(['awaiting-user', 'waiting-for-yes'])
const BUSY_STATES: ReadonlySet<string> = new Set(['working', 'queued', 'provider-limited'])

/** G1 and the not-idle keep from main's reading; null when the reading lets the rule go on. */
export function keepReasonFromReading(reading: IdleKeepReading | undefined): IdleKeepReason | null {
  if (!reading || reading.failed) {
    return 'unreadable'
  }
  if (reading.openAsk || (reading.state !== null && ASKING_STATES.has(reading.state))) {
    return 'open-ask'
  }
  if (reading.keepGoing || (reading.state !== null && BUSY_STATES.has(reading.state))) {
    return 'not-idle'
  }
  if (reading.waitingOn) {
    return 'pending-wait'
  }
  return null
}

const NUMBERED_LINE = /^\s*\d+\./
// Why strip these: markdown emphasis, quotes or a closing bracket after the question mark.
const TRAILING_CLOSERS = /[\s*_`"'”’)\]]+$/

/**
 * G1 from the words alone: the reply ends with "?", or holds two or more numbered lines (a
 * numbered question list). On 2026-09-30 a session holding Sal's three numbered questions read
 * `done` for 42 minutes, and he answered it 66 s after it was nearly stopped.
 */
export function hasOpenAskText(text: string | null | undefined): boolean {
  if (!text) {
    return false
  }
  if (text.replace(TRAILING_CLOSERS, '').endsWith('?')) {
    return true
  }
  let numbered = 0
  for (const line of text.split(/\r?\n/)) {
    if (NUMBERED_LINE.test(line) && ++numbered >= 2) {
      return true
    }
  }
  return false
}

/** Unknown or missing values read as the default: shadow never acts. */
export function getEffectiveIdleAutoCloseMode(value: unknown): IdleAutoCloseMode {
  return (IDLE_AUTO_CLOSE_MODES as readonly unknown[]).includes(value)
    ? (value as IdleAutoCloseMode)
    : DEFAULT_IDLE_AUTO_CLOSE_MODE
}

export function getEffectiveIdleAutoCloseMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_IDLE_AUTO_CLOSE_MINUTES
  }
  return Math.min(MAX_IDLE_AUTO_CLOSE_MINUTES, Math.max(MIN_IDLE_AUTO_CLOSE_MINUTES, value))
}

export function getEffectiveIdleAutoCloseMs(value: unknown): number {
  return getEffectiveIdleAutoCloseMinutes(value) * MS_PER_MINUTE
}

/**
 * Why read loosely: callers pass partial settings. Every loaded profile carries the guard's
 * default (true); only an explicit true counts here, so a partial object never lets `on` act.
 */
export function isRestoreFloodGuardOn(settings: object | null | undefined): boolean {
  const loose = settings as { restoreFloodGuard?: unknown } | null | undefined
  return loose?.restoreFloodGuard === true
}

export type IdleAutoCloseGate =
  | { mode: 'off'; act: false }
  | { mode: 'shadow'; act: false; refused?: 'restore-flood-guard-off' }
  | { mode: 'on'; act: true }

/** What the idle rules may do now: `on` refuses to act unless the restore flood guard is on. */
export function resolveIdleAutoCloseGate(
  settings: { idleAutoCloseMode?: unknown } | null | undefined
): IdleAutoCloseGate {
  const mode = getEffectiveIdleAutoCloseMode(settings?.idleAutoCloseMode)
  if (mode === 'off') {
    return { mode: 'off', act: false }
  }
  if (mode === 'shadow') {
    return { mode: 'shadow', act: false }
  }
  return isRestoreFloodGuardOn(settings)
    ? { mode: 'on', act: true }
    : { mode: 'shadow', act: false, refused: 'restore-flood-guard-off' }
}
