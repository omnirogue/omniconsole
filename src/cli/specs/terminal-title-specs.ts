import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// Why its own file: core.ts is at its line budget; these are the title-setting terminal specs.
export const TITLE_ORIGIN_NOTE =
  "--title-origin says whose words the title is: yours (the person told you the title), generated (you or a launcher wrote it) or unknown (the default when omitted). A generated title may later be offered for a better name; the person's own never is."

export const AGENT_TEMPLATE_LAUNCH_NOTE =
  '--agent-template <id> records which agent template (omni agents list) the session runs as; Session details shows it. The id is resolved on the host when the session starts, and an unknown id refuses the launch. It records the choice only: put the instructions in the command or prompt yourself.'

export const TERMINAL_CREATE_TITLE_FIELDS: Pick<CommandSpec, 'usage' | 'allowedFlags' | 'notes'> = {
  usage:
    'omni terminal create [--worktree <selector>] [--title <name>] [--title-origin yours|generated|unknown] [--command <text>] [--agent-template <id>] [--focus] [--folder <id|path>] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'worktree',
    'command',
    'title',
    'title-origin',
    'focus',
    'folder',
    'agent-template'
  ],
  notes: [
    'Creates a visible terminal tab without switching focus when possible; falls back to a background handle if the UI cannot adopt it. Pass --focus to switch to it.',
    'Use this, not worktree create, for a shell or a non-agent command in the current checkout. Start Claude or Codex with omni session launch, which pins a verified account, not with --command <agent>; supervised workers start with omni orchestration worker-start. --folder files the new session in a Conversations sidebar folder (id or path, e.g. "Saved Sessions / Clients"; see omni folder list). A terminal filed in a project does not inherit the project; the result warns and names omni session launch --folder and omni orchestration worker-start --project, which do.',
    TITLE_ORIGIN_NOTE,
    AGENT_TEMPLATE_LAUNCH_NOTE
  ]
}

export const TERMINAL_RENAME_TITLE_FIELDS: Pick<CommandSpec, 'usage' | 'allowedFlags' | 'notes'> = {
  usage:
    'omni terminal rename [--terminal <handle>] [--title <text>] [--title-origin yours|generated|unknown] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'title', 'title-origin'],
  notes: [
    'Omit --title or pass an empty string to reset to the auto-generated title.',
    `${TITLE_ORIGIN_NOTE} The rename is recorded in the session history (omni session history).`
  ]
}
