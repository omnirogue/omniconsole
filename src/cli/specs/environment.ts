import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['host', 'list'],
    summary: 'List every machine this OmniConsole host can target, and how to name each one',
    usage:
      'omni host list [--capacity --provider <claude|codex> [--project <id>] [--model <id>]] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'capacity', 'provider', 'project', 'model'],
    notes: [
      'Answers "what can I target and what do I pass" in one place: this machine, the SSH targets registered on it, and the OmniConsole servers paired with it.',
      'The three kinds are reached differently. A paired OmniConsole server is a connection, selected with --environment <name>. An SSH target is a machine the connected OmniConsole host reaches, selected with --host ssh:<id>. Passing one where the other belongs is the most common way to get an empty or missing-host answer.',
      'For launches, `omni session launch --host <name>` accepts either kind: pass the name from the launch column and the command picks the route. Selectors and launch flags are shell-quoted, ready to paste.',
      "SSH targets are read from the OmniConsole host you are currently connected to, so this lists that host's targets and not another server's.",
      '--capacity reads every computer from this one, read-only (three at a time, 45 s overall): one row per physical computer (routes merge only by machine id) with its best fresh verified account headroom, bound window, reading age, verified/considered accounts, load band and whether it can take a launch now. A computer that does not answer is unverifiable, never idle or 0%.',
      "--capacity --project <id> also counts each computer's ready setups of that project and recommends `omni session launch --provider <p> --project <id> --prompt-file <brief.md> --json`, which picks the computer and the account itself.",
      'A computer whose OmniConsole predates agent-session.verified-account-launch.v1 still shows its account headroom, read-only, and is marked "launch needs OmniConsole update"; nothing is launched there until it is updated.'
    ],
    examples: [
      'omni host list',
      'omni host list --json',
      'omni host list --capacity --provider claude',
      'omni host list --capacity --provider codex --project github:omnirogue/omni-ide --json'
    ]
  },
  {
    path: ['environment', 'add'],
    summary: 'Save a remote OmniConsole runtime environment from a pairing code',
    usage: 'omni environment add --name <name> --pairing-code <code> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    examples: ['omni environment add --name work-laptop --pairing-code omni://pair?code=...']
  },
  {
    path: ['environment', 'list'],
    summary: 'List saved OmniConsole runtime environments',
    usage: 'omni environment list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'show'],
    summary: 'Show one saved OmniConsole runtime environment',
    usage: 'omni environment show --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'rm'],
    destructive: true,
    summary: 'Remove one saved OmniConsole runtime environment',
    usage: 'omni environment rm --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  }
]
