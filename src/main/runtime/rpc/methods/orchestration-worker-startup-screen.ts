import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/runtime-terminal-contracts'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  detectAgentStartupIntervention,
  type AgentStartupInterventionKind
} from '../../../../shared/agent-startup-intervention'

const CODEX_STARTUP_BLOCKERS: Record<
  AgentStartupInterventionKind,
  RuntimeTerminalWaitBlockedReason
> = {
  'update-available': 'codex-update-prompt',
  'automation-review': 'codex-hooks-review-prompt',
  'trust-prompt': 'codex-trust-workspace',
  'login-required': 'codex-interactive-prompt',
  onboarding: 'codex-interactive-prompt',
  'permission-mode': 'codex-interactive-prompt',
  'model-migration': 'codex-model-migration-prompt',
  'cwd-prompt': 'codex-cwd-prompt'
}

/** The one runtime read this check needs; a narrow shape keeps it testable without a runtime. */
export type StartupScreenReader = {
  readTerminal: (
    handle: string,
    options: { screen: true; limit: number }
  ) => Promise<{ tail: string[]; source?: string }>
}

// Claude Code's own startup dialogs, as the rendered screen reads them. Why the screen: the
// stream the readiness wait scans loses the spaces these dialogs draw with cursor moves, and
// Claude's title reads idle under them, so readiness passed and the task prompt was typed into
// the dialog, whose Enter answered "No, exit".
const CLAUDE_STARTUP_DIALOGS: readonly [RegExp, RuntimeTerminalWaitBlockedReason][] = [
  [
    /Yes, I trust this folder|Is this a project you (?:created or one you )?trust|Do you trust the files in this folder/i,
    'codex-trust-workspace'
  ],
  [/Bypass Permissions mode[\s\S]*Yes, I accept/i, 'codex-interactive-prompt']
]
// Every one of them offers "No, exit" as a choice of its own, on a line of its own.
const NO_EXIT_CHOICE = /^\s*│?\s*(?:[❯>›]\s*)?(?:\d+\.\s*)?No,\s*exit\s*│?\s*$/im
/** How far up from the last drawn line a live startup dialog reaches. */
const STARTUP_DIALOG_LINES = 20

/**
 * The bottom of a rendered screen, where a live dialog is drawn. Why bounded: a reused terminal's
 * transcript can quote a dialog's words (this repository's own code does), and only a dialog that
 * still owns the bottom of the screen is waiting on anyone.
 */
export function startupScreenBottom(tail: readonly unknown[]): string {
  const lines = tail.filter((line): line is string => typeof line === 'string')
  let end = lines.length
  while (end > 0 && !lines[end - 1]!.trim()) {
    end -= 1
  }
  return lines.slice(Math.max(0, end - STARTUP_DIALOG_LINES), end).join('\n')
}

/** Which of Claude's startup dialogs the bottom of this rendered screen shows, or null. */
export function claudeStartupDialogOnScreen(
  tail: readonly unknown[]
): RuntimeTerminalWaitBlockedReason | null {
  const bottom = startupScreenBottom(tail)
  if (!NO_EXIT_CHOICE.test(bottom)) {
    return null
  }
  return CLAUDE_STARTUP_DIALOGS.find(([dialog]) => dialog.test(bottom))?.[1] ?? null
}

/**
 * Check rendered startup dialogs even after readiness: stream spacing can hide a live menu.
 * A stream reply keeps answered dialogs in scrollback, so it cannot establish this blocker.
 */
export async function visibleWorkerStartupPrompt(
  runtime: StartupScreenReader,
  handle: string,
  agent: TuiAgent
): Promise<RuntimeTerminalWaitBlockedReason | null> {
  if (agent !== 'codex' && agent !== 'claude' && agent !== 'claude-agent-teams') {
    return null
  }
  try {
    const read = await runtime.readTerminal(handle, { screen: true, limit: 60 })
    if (read.source !== 'screen') {
      return null
    }
    if (agent === 'codex') {
      const intervention = detectAgentStartupIntervention('codex', startupScreenBottom(read.tail))
      return intervention ? CODEX_STARTUP_BLOCKERS[intervention.kind] : null
    }
    return claudeStartupDialogOnScreen(read.tail)
  } catch {
    // An unreadable screen proves nothing; the delivery's own checks still apply.
    return null
  }
}
