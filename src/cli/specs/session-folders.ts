import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const REF_NOTE =
  'A folder is named by its id or its path: "Clients / Acme", "Clients/Acme", or "Saved Sessions / Clients" for one under Saved Sessions ("Saved Sessions" alone is that section itself). Paths are case-insensitive; a unique last part such as "Acme" also works. An ambiguous or unknown name fails and lists the folders it could mean.'

const TOAST_NOTE =
  'Every change shows a toast in the OmniConsole window naming it, with Undo, and unfolds the destination. Changes apply one at a time, in the order sent. Only the omni CLI on the computer running OmniConsole may make them.'

const SESSION_TARGET_NOTE =
  'Inside an OmniConsole terminal the pane is already in the environment (ORCA_PANE_KEY), so by default this acts on the session the command runs in. Name another with --terminal <handle> (from omni terminal list) or --pane <paneKey>.'

const DRY_RUN_NOTE =
  '--dry-run runs every check the real change runs (a refusal is still a refusal) and prints exactly what would change; nothing changes and no toast is shown. --reason (why) and --request (the person\'s own words that asked for it) go into the audit log, <userData>/session-actions.jsonl, one JSON line per applied change with the acting session proven by its pane evidence, else "cli".'

const MOVE_REASON_NOTE =
  'A move needs --reason (why), unless it is a --dry-run: the reason is recorded with the move so the person can see why it happened. Filing a session at launch (omni terminal create --folder, omni session launch --folder) records its own reason.'

const PROVENANCE_FLAGS = ['dry-run', 'reason', 'request']

const PROVENANCE_USAGE = '[--dry-run] [--reason <why>] [--request <words>] [--json]'

const COLOR_NOTE =
  'Colors: red, orange, amber (yellow), green, teal, blue, violet (purple), pink, gray; none clears it. A folder without its own color shows the nearest colored folder above it.'

export const SESSION_FOLDER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['folder', 'list'],
    summary: 'List the Conversations sidebar folders with their paths, sections and colors',
    usage: 'omni folder list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['omni folder list', 'omni folder list --json'],
    notes: [REF_NOTE]
  },
  {
    path: ['folder', 'create'],
    summary: 'Create a Conversations sidebar folder',
    usage: `omni folder create --name <name> [--parent <id|path>] [--saved] ${PROVENANCE_USAGE}`,
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'parent', 'saved', ...PROVENANCE_FLAGS],
    positionalArgs: ['name'],
    examples: [
      'omni folder create --name "Sales"',
      'omni folder create --name "Q3" --saved',
      'omni folder create --name "Acme" --parent "Saved Sessions / Clients" --json'
    ],
    notes: [
      "--saved creates it at the top of Saved Sessions. With --parent it goes inside that folder, in that folder's section.",
      REF_NOTE,
      TOAST_NOTE,
      DRY_RUN_NOTE
    ]
  },
  {
    path: ['folder', 'move'],
    summary:
      'Move a folder, with its subfolders and sessions, into another folder or to the top, or reorder it beside a sibling',
    usage: `omni folder move <id|path> (--into <id|path> | --top [--saved|--active] | --before <id|path> | --after <id|path>) ${PROVENANCE_USAGE}`,
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'folder',
      'into',
      'top',
      'saved',
      'active',
      'before',
      'after',
      ...PROVENANCE_FLAGS
    ],
    positionalArgs: ['folder'],
    examples: [
      'omni folder move "Sales" --into "Saved Sessions / Clients" --reason "the person asked to save Sales"',
      'omni folder move "Saved Sessions / Old" --top --active --reason "back in use"',
      'omni folder move "Sales" --before "Marketing"',
      'omni folder move "Clients / Acme" --after "Clients / Beta"',
      'omni folder move "Sales" --into "Saved Sessions / Clients" --dry-run'
    ],
    notes: [
      "Moving into a folder of the other section saves or unsaves the whole branch. --top keeps the folder's own section unless --saved or --active names the other.",
      `${MOVE_REASON_NOTE} Reordering with --before/--after needs none.`,
      '--before/--after reorder a folder among its siblings (same parent folder, same section), as dragging its heading does; they never change where it lives. To order it among other siblings, move it there with --into or --top first. Top-level Conversations folders keep their order per device, like the sidebar; subfolders and Saved Sessions folders keep it with the folders.',
      REF_NOTE,
      TOAST_NOTE,
      DRY_RUN_NOTE
    ]
  },
  {
    path: ['folder', 'delete'],
    aliases: [['folder', 'rm']],
    destructive: true,
    summary: 'Delete a folder; its subfolders and sessions move up, nothing else is deleted',
    usage: `omni folder delete <id|path> [--keep-sessions] ${PROVENANCE_USAGE}`,
    allowedFlags: [...GLOBAL_FLAGS, 'folder', 'keep-sessions', ...PROVENANCE_FLAGS],
    positionalArgs: ['folder'],
    examples: [
      'omni folder delete "Clients / Acme"',
      'omni folder delete "Old" --keep-sessions',
      'omni folder delete "Old" --dry-run'
    ],
    notes: [
      'Same as the sidebar\'s "Delete folder": only the folder goes. Its subfolders move up to its parent folder (or to the top of its section). Its sessions move up too: into the parent folder; into Saved Sessions for a top-level Saved Sessions folder, so nothing is unsaved; or back to unfiled for a top-level Conversations folder. No session is closed or deleted — to delete a session use omni session delete.',
      '--keep-sessions spells that out and changes nothing: every folder delete keeps its sessions.',
      REF_NOTE,
      TOAST_NOTE,
      DRY_RUN_NOTE
    ]
  },
  {
    path: ['folder', 'rename'],
    summary: 'Rename a Conversations sidebar folder',
    usage: `omni folder rename <id|path> --name <new name> ${PROVENANCE_USAGE}`,
    allowedFlags: [...GLOBAL_FLAGS, 'folder', 'name', ...PROVENANCE_FLAGS],
    positionalArgs: ['folder'],
    examples: ['omni folder rename "Clients / Acme" --name "Acme Corp"'],
    notes: [REF_NOTE, TOAST_NOTE, DRY_RUN_NOTE]
  },
  {
    path: ['folder', 'color'],
    summary: 'Set or clear a folder color',
    usage: `omni folder color <id|path> --color <name|none> ${PROVENANCE_USAGE}`,
    allowedFlags: [...GLOBAL_FLAGS, 'folder', 'color', ...PROVENANCE_FLAGS],
    positionalArgs: ['folder'],
    examples: ['omni folder color "Sales" --color green', 'omni folder color "Sales" --color none'],
    notes: [COLOR_NOTE, REF_NOTE, TOAST_NOTE, DRY_RUN_NOTE]
  },
  {
    path: ['session', 'move'],
    summary: 'File this conversation (or another one) in a folder, in Saved Sessions, or nowhere',
    usage: `omni session move [--terminal <handle> | --pane <paneKey>] (--folder <id|path> | --saved | --unfile) ${PROVENANCE_USAGE}`,
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'terminal',
      'pane',
      'folder',
      'saved',
      'unfile',
      ...PROVENANCE_FLAGS
    ],
    examples: [
      'omni session move --folder "Saved Sessions / Clients" --reason "client work, as asked"',
      'omni session move --saved --reason "the person wants to keep it"',
      'omni session move --terminal term_abc123 --unfile --reason "not part of the launch"',
      'omni session move --pane tab-1:leaf-2 --folder "Clients / Acme" --dry-run'
    ],
    notes: [
      SESSION_TARGET_NOTE,
      MOVE_REASON_NOTE,
      'To start a new session inside a folder: omni terminal create --folder <id|path> [--command <agent>].',
      REF_NOTE,
      TOAST_NOTE,
      DRY_RUN_NOTE
    ]
  },
  {
    path: ['session', 'archive'],
    summary: 'Archive this conversation (or another one), or bring an archived one back',
    usage: `omni session archive [--terminal <handle> | --pane <paneKey> | --ref <ref> | --tab-id <tabId>] [--unarchive] ${PROVENANCE_USAGE}`,
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'terminal',
      'pane',
      'ref',
      'tab-id',
      'unarchive',
      ...PROVENANCE_FLAGS
    ],
    examples: [
      'omni session archive',
      'omni session archive --terminal term_abc123',
      'omni session archive --terminal term_abc123 --unarchive',
      'omni session archive --ref claude:2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c@local --unarchive --reason "Sal asked to continue this work"',
      'omni session archive --pane tab-1:leaf-2 --dry-run --request "archive the dead ones"',
      'omni session archive --tab-id 21b223aa-6fbc-4b3b-b5ff-33ac2ff9af3e --reason "the Council run finished"'
    ],
    notes: [
      "Same as the row's Archive and Unarchive: the conversation moves under Archived and keeps its folder; its tab stays open. --unarchive brings back any archived conversation, archived by hand or filed automatically after a verified finish, and keeps it visible on this computer (the row's own keep-visible choice), so automatic filing does not archive it again. Recorded with its --reason as one organization change. --ref names it from omni session search.",
      SESSION_TARGET_NOTE,
      '--tab-id <tabId> names a workflow conversation (Council, Discover, Evolve, Build + Review), which has no pane: omni session list prints its tabId. Only its row is archived; its run is never cancelled and its history is kept.',
      TOAST_NOTE,
      DRY_RUN_NOTE
    ]
  },
  {
    path: ['session', 'delete'],
    aliases: [['session', 'rm']],
    destructive: true,
    summary: 'Delete this conversation (or another one) from the Conversations list',
    usage: `omni session delete [--terminal <handle> | --pane <paneKey> | --ref <ref> | --tab-id <tabId>] [--force] [--unverified] ${PROVENANCE_USAGE}`,
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'terminal',
      'pane',
      'ref',
      'tab-id',
      'force',
      'unverified',
      ...PROVENANCE_FLAGS
    ],
    examples: [
      'omni session delete --terminal term_abc123',
      'omni session delete --force',
      'omni session delete --pane tab-1:leaf-2 --dry-run --request "delete the finished ads sessions"',
      'omni session delete --pane tab-1:leaf-2 --unverified --request "delete all sessions"',
      'omni session delete --tab-id 21b223aa-6fbc-4b3b-b5ff-33ac2ff9af3e --unverified --request "delete all sessions"'
    ],
    notes: [
      "Same as the sidebar's Delete: its tab closes the way the tab's own close does (history kept, reopenable from Recently closed) and the row leaves the list on this computer. Undo brings the row back; a closed tab is reopened from Recently closed.",
      'A conversation whose agent is still working is refused unless --force, which stops and deletes it (the sidebar asks "Stop and delete?"). So is one whose state rests on its terminal title alone (omni session list shows "(from its title)"): a title never decides a delete by itself. Without --terminal/--pane/--ref/--tab-id this deletes the conversation the command runs in, closing that terminal.',
      'A session another computer or an SSH host runs is never deleted from here, --unverified or not: closing its tab here would stop it there. Delete it on the computer that runs it (for example ssh studio omni session delete …, or omni session tidy --delete there); hide it here with omni session hide.',
      "A session this computer runs but cannot verify (omni session list shows it unknown or unverifiable: no terminal attached, its state unknown) is refused unless --unverified, which needs --request with the person's own words. Its row goes here and no terminal is ended (what it lists may be a live session shown elsewhere); history is kept.",
      '--tab-id <tabId> names a row with no pane: a tab left from an earlier run (omni session list prints its tabId). Such a row cannot be verified, so it also needs --unverified.',
      SESSION_TARGET_NOTE,
      TOAST_NOTE,
      DRY_RUN_NOTE
    ]
  }
]
