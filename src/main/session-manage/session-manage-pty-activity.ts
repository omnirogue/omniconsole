/**
 * What a live terminal pane's agent is doing, once it is confirmed running, from POSITIVE evidence
 * only, strongest first: a fresh hook report from the agent process holding the terminal (working,
 * or waiting on the person); a prompt on its screen; a turn in flight in its title or on its
 * screen; a finished turn (or a ready prompt) on the screen under that agent's own process; and,
 * last, its title alone.
 *
 * A hook report never establishes idle: nothing in it proves which process incarnation sent it (a
 * reused pid passes a pid check), so completion is read only from what the screen or title shows
 * now. A missing marker proves nothing either: that stays `unknown`.
 */

import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-terminal-contracts'
import type { SessionStateBasis } from '../../shared/session-manage-types'
import {
  SCREEN_MARKED_AGENTS,
  type TerminalScreenEvidence
} from '../runtime/terminal-agent-evidence'
import type { SessionAgentActivity } from './session-manage-state'
import { hookActivity, type SessionHookReading } from './session-manage-hook-activity'

/** A hook report as the host last stored it; `restored` when a restart hydrated a nonterminal state. */
export type SessionLastHookReading = SessionHookReading & { restored?: boolean; agent?: string }

export type PtyActivityInput = {
  /** The runtime's reading: `running` from process or title; its `permission` from any source. */
  status: { running: boolean; status: 'working' | 'permission' | 'idle' | null }
  /** What the terminal title alone shows now (never a hook report). */
  title: 'working' | 'permission' | 'idle' | null
  /** A fresh hook report from the agent process holding the terminal now; null otherwise. */
  hook: SessionHookReading | null
  /** The newest stored report, for its words only: it never sets the state. */
  lastHook: SessionLastHookReading | null
  screen: TerminalScreenEvidence | null
  /** The recognized agent whose process holds the terminal, when the process table names one. */
  foregroundAgent: string | null
  /** The agent provably holds the terminal (`agentHoldsForeground`). */
  agentInForeground: boolean
}

export type PtyActivity = { activity: SessionAgentActivity; basis: SessionStateBasis }

const SCREEN_PROMPTS: Record<RuntimeTerminalWaitBlockedReason, SessionAgentActivity> = {
  'codex-trust-workspace': { kind: 'question', prompt: 'the folder-trust prompt on its screen' },
  'codex-update-prompt': { kind: 'question', prompt: 'the update prompt on its screen' },
  'codex-cwd-prompt': { kind: 'question', prompt: 'the working-directory prompt on its screen' },
  'codex-model-migration-prompt': {
    kind: 'question',
    prompt: 'the model-upgrade prompt on its screen'
  },
  'codex-hooks-review-prompt': {
    kind: 'question',
    prompt: 'the hooks-review prompt on its screen'
  },
  'codex-interactive-prompt': { kind: 'question', prompt: 'the prompt on its screen' },
  'agent-approval-prompt': { kind: 'permission', prompt: 'the approval prompt on its screen' }
}

const unknown = (reason: string): PtyActivity => ({
  activity: { kind: 'unknown', reason },
  basis: 'none'
})

export function derivePtyActivity(input: PtyActivityInput): PtyActivity {
  const { status, title, hook, lastHook, screen, foregroundAgent } = input
  if (status.status === 'permission' || title === 'permission') {
    return {
      activity: {
        kind: 'permission',
        ...(hook?.interactivePrompt ? { prompt: hook.interactivePrompt } : {})
      },
      basis: hook ? 'hook' : 'title'
    }
  }
  // Why before the hook: a report is no proof the agent still holds its terminal.
  if (!status.running && !input.agentInForeground) {
    return unknown('Its terminal is live, but its agent could not be confirmed running.')
  }
  if (screen?.conversationLocked) {
    return {
      activity: {
        kind: 'question',
        prompt:
          'its conversation is open in another app; reconcile the existing owner before retrying'
      },
      basis: 'screen'
    }
  }
  // An open menu outranks a prior turn's completion and contradictory hook/title activity.
  if (screen?.promptMenu) {
    return {
      activity: screen.blocked
        ? SCREEN_PROMPTS[screen.blocked]
        : { kind: 'question', prompt: 'the open menu on its screen' },
      basis: 'screen'
    }
  }
  const activity = hook ? hookActivity(hook) : null
  // Why not idle: a finished report is left to what the screen or title shows now (see above).
  if (activity && activity.kind !== 'idle') {
    return { activity, basis: 'hook' }
  }
  if (screen?.blocked) {
    return { activity: SCREEN_PROMPTS[screen.blocked], basis: 'screen' }
  }
  if (title === 'working') {
    return { activity: { kind: 'working' }, basis: 'title' }
  }
  if (screen?.working) {
    return { activity: { kind: 'working' }, basis: 'screen' }
  }
  if (
    screen &&
    foregroundAgent &&
    (screen.readyPrompt || (screen.turnDone && SCREEN_MARKED_AGENTS.has(foregroundAgent)))
  ) {
    return { activity: { kind: 'idle' }, basis: 'screen' }
  }
  if (title === 'idle') {
    return { activity: { kind: 'idle' }, basis: 'title' }
  }
  if (lastHook?.restored) {
    return unknown(
      `Its last report, from before a restart, said it was ${lastHook.state === 'working' ? 'working' : 'waiting on you'}, and nothing since confirms what it is doing now.`
    )
  }
  return unknown(
    lastHook || hook
      ? 'Its reports cannot show it idle (a report cannot prove which process sent it), and nothing on its screen or title shows it idle now.'
      : 'Its agent has not reported a state yet.'
  )
}
