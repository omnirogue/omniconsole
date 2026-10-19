import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const PROJECT_NOTE =
  'A project is a top-level Conversations folder (or a folder inside a company folder) with project settings: repos, files, Slite/OmniOS docs, skills, default agents and company/domain. Every session started in it inherits them: omni session launch --folder <project> adds them to the brief, resolved for the target host.'

const HUMAN_MADE_NOTE =
  'People make projects in OmniConsole (the folder menu’s "Set up as project…"). No CLI caller can create one; an agent may only suggest one, and the person decides in the window.'

export const SESSION_PROJECT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['folder', 'projects'],
    summary: 'List the projects on the computer running OmniConsole, with their threads by status',
    usage: 'omni folder projects [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['omni folder projects', 'omni folder projects --json'],
    notes: [
      PROJECT_NOTE,
      'Each project shows its repos count, its coordinator and its threads as its page counts them (JSON threads; null when they could not be counted). A paired desktop may list them too, to dispatch into one; an agent on another computer may not. A runtime without session-projects.list.v1 refuses the call.'
    ]
  },
  {
    path: ['folder', 'project'],
    summary: 'Show the project a Conversations folder belongs to and its inherited settings',
    usage: 'omni folder project --folder <id|path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'folder'],
    positionalArgs: ['folder'],
    examples: ['omni folder project "OmniRogue / Ads"', 'omni folder project --folder <id> --json'],
    notes: [
      PROJECT_NOTE,
      'It also shows the coordinator (its launch pick and whether its chat is running), the project’s threads by status as its page counts them (JSON threads; omni session list --project lists them), and the project’s Jira issues (settings.tasks). Issues are links for the page and the coordinator; threads never inherit them.',
      HUMAN_MADE_NOTE
    ]
  },
  {
    path: ['folder', 'project-suggest'],
    summary: 'Suggest to the person that a folder becomes a project; they decide in the window',
    usage: 'omni folder project-suggest --folder <id|path> --reason <why> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'folder', 'reason'],
    positionalArgs: ['folder'],
    examples: [
      'omni folder project-suggest "Ads" --reason "Five sessions this week share the same repos and docs"'
    ],
    notes: [HUMAN_MADE_NOTE, 'The window shows the suggestion with a "Set up project" button.']
  },
  {
    path: ['folder', 'project-create'],
    summary: 'Always refused: projects are made by a person in OmniConsole',
    usage: 'omni folder project-create --folder <id|path>',
    allowedFlags: [...GLOBAL_FLAGS, 'folder'],
    positionalArgs: ['folder'],
    examples: ['omni folder project-suggest "Ads" --reason "<why>"'],
    notes: [HUMAN_MADE_NOTE]
  }
]
