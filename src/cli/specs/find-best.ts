import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const FIND_BEST_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['find-best'],
    summary:
      'Find the best: many options (or complete versions), JEV scores them all, the best come back',
    usage:
      'omni find-best <what to find> [--list <file|-> | --file <csv|json>] [--count <n>] [--versions <n>] [--keep <n>] [--final <n>] [--rubric <name>] [--good <text>] [--worktree <selector>] [--operation-id <uuid>] [--no-follow] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'prompt',
      'list',
      'file',
      'count',
      'versions',
      'keep',
      'final',
      'rubric',
      'good',
      'worktree',
      'operation-id',
      'no-follow'
    ],
    positionalArgs: ['prompt'],
    examples: [
      'omni find-best "Business ideas a one-person studio could start this month"',
      'omni find-best "The best job queue for a Postgres-only Node SaaS" --list repos.txt --rubric "GitHub repository"',
      'omni find-best "The opening paragraph of our landing page" --versions 4 --rubric "Landing page"',
      'omni find-best "Ad hooks for the spring sale" --count 100 --keep 20 --good "- Under 12 words\\n- Names the offer" --json'
    ],
    notes: [
      'Keep --operation-id for retries: one request uses one workflow conversation and execution. Reusing it for different work is refused.',
      'Opens a Find the best conversation in the workspace (the current one by default), starts it, and follows it: progress goes to stderr, the report to stdout.',
      'Every option and score is also saved in the workspace under .omni/find/ as Markdown and CSV; the report ends with where.',
      '--list reads one option per line from a file, or from stdin with -. --versions has each model write a complete version (2-8) instead of listing options.',
      '--file imports CSV or JSON (title/name, detail/description, url/link). Choose only one source.',
      '--keep is how many of the best come back (up to 100); --final is how many meet head to head (up to 8).',
      '--rubric names a rubric from the library, built in or saved; --good adds what else matters, one criterion per line.',
      'Ctrl-C stops following, not the run; --no-follow returns as soon as the run starts.'
    ]
  }
]
