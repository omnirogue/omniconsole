import type { AutomaticSessionCleanupProtectionConfig } from './automatic-session-cleanup-protection'
import type { SessionHostControlSettings } from './session-host-control-settings'
import type { SessionQuestionsSettings } from './session-questions-settings'
import type { SessionStewardSettings } from './session-steward-settings'

/** The settings that govern automatic work on sessions: this computer's steward and host switches. */
export type SessionAutomationSettings = {
  /** Route self-contained new objectives; follow-ups keep their current owner. */
  automaticOutcomeDispatch?: boolean
  dispatchRoutingMode?: 'off' | 'shadow' | 'live'
  /** Latency telemetry (keystroke-to-echo, main event-loop delay, launch triggers), written to
   *  the local trace file only; measuring never changes behaviour. Default on; false is the kill
   *  switch. Why here: global-settings-types.ts is at its max-lines budget. */
  latencyTelemetry?: boolean
  /** The session steward's switches, all on by default. Optional for older profiles. */
  sessionSteward?: SessionStewardSettings
  /** This computer as an execution host (Phase 4), all on by default. Optional for older profiles. */
  sessionHostControl?: SessionHostControlSettings
  /** Idle rules R1-R3 (idle-auto-close-settings.ts): `shadow` (default) only logs, `on` acts while
   *  the restore flood guard is on, `off` is the kill switch. R1 yields to agent hibernation when
   *  that is on. Why here: global-settings-types.ts is at its max-lines budget. */
  idleAutoCloseMode?: 'shadow' | 'on' | 'off'
  /** Minutes a done agent, bare shell or hidden browser page must stay idle (R1-R3); default 30. */
  idleAutoCloseMinutes?: number
  /** Owner-local protections. Missing or invalid configuration keeps automatic cleanup inert. */
  automaticSessionCleanupProtection?: AutomaticSessionCleanupProtectionConfig | null
  /** Opt in to the Projects overview at launch; missing means off.
   *  Why here: global-settings-types.ts is at its max-lines budget. */
  openProjectsOnStart?: boolean
  /** Questions sessions ask, answered from Needs you. Optional for older profiles. */
  sessionQuestions?: SessionQuestionsSettings
  /** The restore flood guard (2026-09-30). A finished slept agent (origin 'worktree-sleep',
   *  state 'done'), an idle 'quit'/'live' checkpoint, a tab-open-only record or an archived pane
   *  resumes only for a person (its tab revealed or on screen, a live interactive ask, a touch in
   *  the last 10 minutes), never from a background mount; 'quit'/'live' agents that were mid-task
   *  still auto-continue unless put away (archived, hidden, deleted); no provider session a live
   *  OmniConsole PTY runs is resumed twice. Default on; false restores the earlier eager behavior
   *  and also lifts the agent start window below (kill switch for the whole fix). */
  restoreFloodGuard?: boolean
  /** App-wide cap on agent starts per rolling 10 seconds while restoreFloodGuard is on; excess
   *  starts queue (a person's first, then CLI/orchestration starts, then background restores).
   *  Default 3, 0 = unlimited. */
  launchAdmissionPer10s?: number
  /**
   * "Archive = pause": a person's archive puts an idle local agent to sleep (a working one when it
   * finishes); other archives sleep it after 30 idle minutes out of view. Opening the conversation
   * resumes it. On unless explicitly false; inert while restoreFloodGuard is off.
   */
  archiveSleepsIdleAgents?: boolean
  /**
   * Minutes a session that published a review page stays live in Waiting after its turn before
   * it sleeps until a decision wakes it (artifact-review-sleep.ts); default 60. Inert unless idle
   * auto-close acts (On with the restore flood guard) and the cleanup protection is configured.
   */
  reviewWaitLiveMinutes?: number
  /**
   * Quiet background agent runs (2026-10-01). OmniConsole's own background Claude runs (model
   * listings, session summaries, commit messages and the other one-shot text runs) skip the
   * person's hooks, MCP servers, settings files and slash commands and keep no transcript; model
   * listings run one at a time and never on a timer: an agent is listed when first needed, each
   * launcher opening asks the host again, and a surface keeps showing its last good listing past
   * the 30-minute lifetime while a click re-checks it. The host reuses each CLI's listing for an
   * hour while its binary is unchanged (a failed or seed-fallback one for 5 minutes, unless a
   * launch forces it), SSH hosts' listings per connection and OMP's routing check per OMP binary;
   * session summaries wait while the 1-minute load is above 8 and for 10 minutes after app start
   * or a restore sweep. On unless explicitly false; false restores the earlier behaviour (listings
   * side by side, re-listed on the minute tick once a minute old, read as expired after 2 minutes).
   */
  quietBackgroundAgentRuns?: boolean
  /**
   * Agent-created worktrees (CLI, orchestration workers, automations) leave no bare shells: no
   * fallback "Terminal 1" unless the caller asks for one (`omni worktree create --terminal`), and
   * the runtime-run Setup tab closes once setup exits 0 (a failed setup stays open to show why).
   * A person's create is unchanged. On unless explicitly false.
   */
  tidyAgentWorktreeTerminals?: boolean
}
