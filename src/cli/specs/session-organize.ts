import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const PANES_NOTE =
  '--pane takes one pane key or several, comma-separated (from omni session list). Without it, the session the command runs in (ORCA_PANE_KEY).'

const REASON_NOTE =
  'Needs --reason "<why>" unless it is a --dry-run: the reason is recorded once for the whole change, however many sessions it touches, and shows in each session\'s history. Pass --request with the person\'s own words when they asked for it.'

const RECORD_NOTE =
  'Many sessions are one recorded change: one reason and one Undo. The OmniConsole window shows one notice with Undo; an Undo skips any session changed since. Only the omni CLI on the computer running OmniConsole may make these changes.'

const NEEDS_YOU_NOTE =
  'A session asking the person something (awaiting-user or waiting-for-yes in omni session list) cannot be hidden or snoozed: it stays in Needs you. It is skipped with that reason.'

const PROVENANCE_FLAGS = ['pane', 'dry-run', 'reason', 'request']

export const SESSION_ORGANIZE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'tag'],
    summary: 'Add or remove tags on sessions, as the sidebar tag picker does',
    usage:
      'omni session tag [--pane <paneKey>[,<paneKey>...]] [--add <tag>[,<tag>...]] [--remove <tag>[,<tag>...]] --reason <why> [--request <words>] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'add', 'remove', ...PROVENANCE_FLAGS],
    examples: [
      'omni session tag --pane tab-1:leaf-2,tab-3:leaf-1 --add OmniRogue --reason "checkout work for OmniRogue"',
      'omni session tag --pane tab-1:leaf-2 --remove BetaCorp --reason "tagged by mistake" --dry-run'
    ],
    notes: [
      'A tag is named by its name (case-insensitive) or id; only existing tags can be added. A session with no tags chosen keeps its automatic company tag when another is added.',
      PANES_NOTE,
      REASON_NOTE,
      RECORD_NOTE
    ]
  },
  {
    path: ['session', 'hide'],
    summary: 'Hide sessions that do not need to be seen from the Conversations sidebar',
    usage:
      'omni session hide [--pane <paneKey>[,<paneKey>...]] --reason <why> [--request <words>] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...PROVENANCE_FLAGS],
    examples: [
      'omni session hide --pane tab-1:leaf-2,tab-4:leaf-1 --reason "quiet background runs"'
    ],
    notes: [
      'Same as the sidebar\'s Hide: the row leaves the default view on this computer and "Show hidden" brings it back. Nothing is stopped or archived.',
      NEEDS_YOU_NOTE,
      PANES_NOTE,
      REASON_NOTE,
      RECORD_NOTE
    ]
  },
  {
    path: ['session', 'unhide'],
    summary: 'Show hidden sessions in the Conversations sidebar again',
    usage:
      'omni session unhide [--pane <paneKey>[,<paneKey>...]] --reason <why> [--request <words>] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...PROVENANCE_FLAGS],
    examples: ['omni session unhide --pane tab-1:leaf-2 --reason "the person wants to watch it"'],
    notes: [PANES_NOTE, REASON_NOTE, RECORD_NOTE]
  },
  {
    path: ['session', 'snooze'],
    summary: 'Put sessions away until a time, or wake them now',
    usage:
      'omni session snooze [--pane <paneKey>[,<paneKey>...]] --until <ISO|+2h|30m|+1d|today 17:00|tomorrow 9:00|none> --reason <why> [--request <words>] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'until', ...PROVENANCE_FLAGS],
    examples: [
      'omni session snooze --pane tab-2:leaf-1 --until "tomorrow 9:00" --reason "waiting on the ad review"',
      'omni session snooze --pane tab-2:leaf-1,tab-5:leaf-1 --until +2h --reason "CI takes two hours"',
      'omni session snooze --pane tab-2:leaf-1 --until none --reason "the review came back"'
    ],
    notes: [
      "A snoozed row leaves the default sidebar view on this computer until its time, then comes back by itself; nothing underneath is stopped or changed. Times are this computer's local time. none wakes it now.",
      NEEDS_YOU_NOTE,
      PANES_NOTE,
      REASON_NOTE,
      RECORD_NOTE
    ]
  },
  {
    path: ['session', 'organize'],
    summary:
      'Organize many sessions in one step from a plan: folders, moves, tags, hides, snoozes, archives',
    usage:
      'omni session organize --plan <file|-> [--apply] [--reason <why>] [--request <words>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plan', 'apply', 'dry-run', 'reason', 'request'],
    examples: [
      'omni session organize --plan plan.json',
      'omni session organize --plan plan.json --json > checked.json',
      'jq .result.plan checked.json | omni session organize --plan - --apply --request "tidy my sidebar"'
    ],
    notes: [
      'The plan is JSON: {"reason": "...", "request": "...", "folders": [{"create": "OmniRogue / Checkout", "color": "green"}], "changes": [{"pane": "tab-1:leaf-2", "folder": "OmniRogue / Checkout" | "unfile": true, "archive": true, "hide": true, "snooze": "tomorrow 9:00" | null, "addTags": ["OmniRogue"], "removeTags": ["BetaCorp"], "title": "...", "origin": "yours" | "generated"}]}. Every field but pane is optional; a title needs origin. folders[] creates missing folders (parents too) and sets their color before anything moves.',
      "A dry run is the default: it changes nothing and prints the grouped plan, what is skipped and why (unknown panes, no-ops, sessions asking the person), and how many lines the default sidebar would show before and after against the five-line budget. With --json its result.plan is the same plan with each session's current revision; applying that plan skips any session organized since the dry run.",
      "--apply records one change per kind (all moves, all hides, ...) with every session in it, one reason and one request, re-checks each session just before applying, and reports what changed and what was skipped. The window shows one notice with one Undo for the whole plan. --reason and --request override the plan's.",
      'Titles are applied once the window supports recorded titles; until then use omni session rename.',
      NEEDS_YOU_NOTE,
      'Only the omni CLI on the computer running OmniConsole may organize.'
    ]
  }
]
