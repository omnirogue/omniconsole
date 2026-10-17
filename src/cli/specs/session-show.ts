import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const SESSION_SHOW_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'show'],
    summary: 'Pull a conversation into view beside the current one, highlighted',
    usage:
      'omni session show (--pane <paneKey> | --terminal <handle>) [--beside | --replace] [--no-flash] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'pane', 'terminal', 'beside', 'replace', 'no-flash'],
    examples: [
      'omni session show --pane tab-1:leaf-2',
      'omni session show --pane tab-1:leaf-2 --replace --json',
      'omni session show --terminal term_abc123 --no-flash'
    ],
    notes: [
      '--beside (the default) keeps what the person is looking at on the left and puts the conversation on the right: in the same workspace, a new split on the right; from another workspace (or while the Grid is open), the Grid with the current view on the left. A full Grid gives up its least recently used pane, never the current one. A conversation already on screen stays where it is.',
      '--replace shows it in place of the current view, the same as omni terminal focus. Either way its pane rim flashes and its sidebar row scrolls into view and pulses; --no-flash skips both.',
      'Keyboard focus is never taken from a composer, text field or editor holding unsent text: the conversation is placed and highlighted, and the person keeps typing.',
      'It changes no conversation (nothing is sent, moved between folders or audited). Only the omni CLI on the computer running OmniConsole moves its window; from a paired device or another computer it shows nothing and exits non-zero.',
      '--json: {shown, mode, placement (split|grid|grid-replaced|already-shown|replaced|null), keptKeyboardFocus, target: {paneKey, tabId, title, worktreeId}, summary}. Exits non-zero unless shown.',
      'For "what is X doing?", pair it with omni session ask --pane <paneKey> for the two-line status.'
    ]
  }
]
