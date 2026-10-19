import { GLOBAL_FLAGS, type CommandSpec } from '../args'

const RESOLVED_NOTE =
  'Templates are resolved: built-ins with their Settings overrides applied, then custom templates. digest is the first 12 hex of the sha256 of the instructions; a session records it at launch, so Session details can say when the text changed since.'

export const AGENT_TEMPLATE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agents', 'list'],
    summary: 'List agent templates with their instructions and digest',
    usage: 'omni agents list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['omni agents list', 'omni agents list --json'],
    notes: [
      RESOLVED_NOTE,
      'Launch with one: omni terminal create --agent-template <id> or omni session launch --agent-template <id>.'
    ]
  },
  {
    path: ['agents', 'show'],
    summary: 'Show one agent template, including its full instructions',
    usage: 'omni agents show --id <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    examples: ['omni agents show --id advertising --json'],
    notes: [RESOLVED_NOTE]
  },
  {
    path: ['agents', 'set'],
    summary: 'Create or update a custom template, or override a built-in',
    usage:
      'omni agents set --id <id> [--name <name>] [--description <text>] (--instructions-file <path> | --instructions <text>) [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'id',
      'name',
      'description',
      'instructions',
      'instructions-file'
    ],
    examples: [
      'omni agents set --id advertising --instructions-file ./advertising.md',
      'omni agents set --id qa --name "QA" --description "Tests before it claims done" --instructions "Run the targeted tests first."',
      'omni agents set --id reviewer --instructions-file ./reviewer.md --json'
    ],
    notes: [
      'Writes through the same settings path as Settings › Agents › Agent templates, so the open app shows it at once and does not overwrite it. Prints the new digest.',
      'A new id needs --name. Built-in ids (developer, reviewer, researcher) take an override of their instructions and description; their names are fixed. Default adds nothing and cannot be set.',
      'Ids are lowercase letters, digits and hyphens (up to 64). Instructions are capped at 20,000 characters and names at 80; a longer value is refused, never cut. At most 50 custom templates.',
      'Sessions already running keep the text they started with; new launches use the new text.',
      '--instructions sends its text as given: a shell does not turn \\n inside double quotes into a newline, so put multi-line instructions in a file and use --instructions-file.',
      '--instructions-file is read on the computer running the CLI; through a forwarded SSH/WSL shell use --instructions.'
    ]
  },
  {
    path: ['agents', 'rm'],
    aliases: [['agents', 'remove']],
    summary: 'Remove a custom agent template',
    usage: 'omni agents rm --id <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    examples: ['omni agents rm --id qa', 'omni agents remove --id qa'],
    notes: [
      'Only custom templates can be removed; to undo a built-in override, use Reset in Settings › Agents. Sessions that used it show "<name> (removed)" in Session details.'
    ]
  }
]
