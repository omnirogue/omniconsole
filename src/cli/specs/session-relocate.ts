import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const SESSION_RELOCATE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'relocate'],
    summary: 'Move the same conversation to another computer (only when a person asks)',
    usage:
      'omni session relocate (--pane <key> | --terminal <handle> | --ref <ref>) --to (local | ssh:<id> | runtime:<id>) --workspace <path there> [--commit <sha>] [--continue <move id>] [--reason "<why>"] [--request "<the person\'s words>"] [--dry-run] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'pane',
      'terminal',
      'ref',
      'to',
      'workspace',
      'commit',
      'continue',
      'reason',
      'request',
      'dry-run'
    ],
    examples: [
      'omni session relocate --pane tab-1:leaf-1 --to ssh:mw0002 --workspace ~/work/app --dry-run',
      'omni session relocate --pane tab-1:leaf-1 --to runtime:laptop --workspace /Users/maintainer/work/app --reason "Needs the laptop overnight" --json',
      'omni session relocate --pane tab-1:leaf-1 --to ssh:mw0002 --workspace ~/work/app --continue 1790337600123-0123456789abcdef0123456789abcdef'
    ],
    notes: [
      'The same conversation (same Claude or Codex session id, its whole history) moves; a handoff instead starts a new one from a brief. Both computers must offer it: omni session hosts says which can take moved conversations. An older one is refused before anything moves; update OmniConsole there first.',
      'Steps, each recorded before it is sent: the destination checks its CLI version, the workspace (--workspace; a git checkout must be at --commit, which defaults to this checkout’s HEAD, and clean) and an account with capacity; the source is reserved, its idle agent stopped with proof it exited, and its native files exported with checksums (never credentials); the files are copied chunk by chunk and staged; the source hands ownership to exactly that computer, which resumes the same conversation once and accepts work only after the provider confirms the id.',
      'A copy that fails or does not match stages nothing, and the conversation stays here, released as it was. Once the source hands over it never runs the conversation again. A computer that stops answering leaves the move blocked, never duplicated: run the command again with --continue <move id> to finish it (only recorded requests are resent).',
      'Only a person’s explicit request moves a conversation; an automatic caller gets a proposal and nothing moves. It never rents or sets up a computer. OMNI_RELOCATION_DISABLED=1 (or the relocation setting) turns moves off on a computer.',
      '--dry-run checks both computers and the conversation, lists what would happen and changes nothing. --json: {relocation, outcome (relocated|planned|proposed|refused|abandoned|blocked|owned-unconfirmed), provider, source, destination, ownerEpoch?, steps: [{step, operationId, state, detail?}], summary, code?}. Anything but relocated, planned or proposed exits non-zero.'
    ]
  }
]
