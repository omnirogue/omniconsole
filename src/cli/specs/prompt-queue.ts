import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const PANE_NOTE =
  'Inside an OmniConsole session the pane and workspace are already in the environment (ORCA_PANE_KEY, ORCA_WORKTREE_ID), so `omni prompt-queue list` needs no flags. Pass --pane/--worktree to read another conversation.'

const WRITE_NOTE =
  'Queuing and unqueuing are decisions the host admits only from the authenticated user interface (the app window or a paired device). The CLI reaches the runtime over the local socket with no client identity, and nothing available to it distinguishes the person from an agent running in the same pane — so it refuses here rather than pretend. Type `/next <prompt>` in the terminal itself, which the app intercepts as your own keystrokes.'

const SAME_QUEUE_NOTE =
  'The same queue the UI shows: `/next <prompt>` in a terminal or the chat composer, and the strip under the work header. A queued prompt is delivered when the agent finishes; it creates no outcome, plan or card.'

export const PROMPT_QUEUE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['prompt-queue', 'list'],
    summary: 'Show the prompts waiting for a conversation, in order',
    usage: 'omni prompt-queue list [--pane <key>] [--worktree <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'pane', 'worktree'],
    examples: ['omni prompt-queue list', 'omni prompt-queue list --json'],
    notes: [PANE_NOTE, SAME_QUEUE_NOTE]
  },
  {
    path: ['prompt-queue', 'add'],
    summary: 'Not available from the CLI — type /next <prompt> in the terminal instead',
    usage: 'omni prompt-queue add "<text>"   (refused; use /next <prompt> in the terminal)',
    allowedFlags: [...GLOBAL_FLAGS, 'text', 'pane', 'worktree'],
    positionalArgs: ['text'],
    examples: ['omni prompt-queue list'],
    notes: [WRITE_NOTE, SAME_QUEUE_NOTE]
  },
  {
    path: ['prompt-queue', 'clear'],
    summary: 'Not available from the CLI — use the strip, or /queue clear in the terminal',
    usage: 'omni prompt-queue clear   (refused; use /queue clear in the terminal)',
    allowedFlags: [...GLOBAL_FLAGS, 'pane', 'worktree'],
    examples: ['omni prompt-queue list'],
    notes: [WRITE_NOTE]
  }
]
