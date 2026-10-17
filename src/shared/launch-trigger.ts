// Launch causes describe admitted spawns in the ledger and optional latency traces.
// A trigger never admits, delays or skips a launch.

// Unknown identifies a creator that failed to name its cause.
export const LAUNCH_TRIGGERS = [
  'person-reveal',
  'background-mount',
  'browser-lease',
  'mobile-wake',
  'restore-interrupted',
  'cold-restore-mount',
  'cli',
  'hibernation-wake',
  'new',
  'unknown',
  'automation',
  'orchestration-worker',
  'coordinator-shell',
  'capacity-recovery',
  'session-transfer',
  'session-handoff',
  'outcome',
  'workflow',
  'steward-resume',
  'agent-session-create',
  'agent-session-resume',
  'session-resume',
  'session-prep',
  'worktree-create',
  'dashboard-popout',
  'worktree-background-terminals',
  'codex-pane-restart',
  'agent-team',
  'ssh-pane-recovery',
  'paired-client',
  'terminal-create',
  'terminal-split',
  'session-tabs-create',
  'renderer-spawn'
] as const

export type LaunchTrigger = (typeof LAUNCH_TRIGGERS)[number]

const LAUNCH_TRIGGER_SET: ReadonlySet<string> = new Set(LAUNCH_TRIGGERS)

export function isLaunchTrigger(value: unknown): value is LaunchTrigger {
  return typeof value === 'string' && LAUNCH_TRIGGER_SET.has(value)
}

/** Any value that is not one of the fixed tokens becomes `unknown`, never free text. */
export function normalizeLaunchTrigger(value: unknown): LaunchTrigger {
  return isLaunchTrigger(value) ? value : 'unknown'
}

/** Triggers a main-process request (not the renderer) can know about. */
export type MainLaunchTriggerHint = LaunchTrigger

// Why only these: a worktree-wide hint (a browser lease, a phone opening a PTY whose
// tab main cannot name) is too coarse to relabel a launch the renderer attributed to
// something specific — a person's reveal, a new agent, a hibernation wake. Both sources
// mount hidden panes only, so a visible pane's cold restore ('cold-restore-mount') is
// never theirs: refining it would blame the startup tab's restore on a lease or phone.
const REFINABLE_RENDERER_TRIGGERS: ReadonlySet<LaunchTrigger> = new Set([
  'background-mount',
  'unknown'
])

/**
 * One launch's trigger from everything that saw it, most specific first:
 * 1. the interrupted-restore auto-continue main armed for this spawn;
 * 2. a main request naming this exact tab (a CLI create, a phone opening the tab);
 * 3. a worktree-wide main request, only over a background/unattributed renderer guess;
 * 4. the renderer's own attribution; otherwise `unknown`.
 */
export function resolveLaunchTrigger(args: {
  /** Main armed the auto-continue (the pane was mid-turn). Not the renderer's
   *  `interruptedRestore` spawn flag: that is set on nearly every cold-restore resume. */
  interruptedAutoContinue?: boolean
  rendererTrigger?: unknown
  tabHint?: MainLaunchTriggerHint | null
  worktreeHint?: MainLaunchTriggerHint | null
}): LaunchTrigger {
  if (args.interruptedAutoContinue === true) {
    return 'restore-interrupted'
  }
  const claimed = normalizeLaunchTrigger(args.rendererTrigger)
  // Why: only main knows whether the pane was mid-turn, so a renderer claim of
  // restore-interrupted is no evidence at all.
  const renderer = claimed === 'restore-interrupted' ? 'unknown' : claimed
  if (args.tabHint) {
    return args.tabHint
  }
  if (args.worktreeHint && REFINABLE_RENDERER_TRIGGERS.has(renderer)) {
    return args.worktreeHint
  }
  return renderer
}
