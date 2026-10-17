import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'
import { WORKFLOW_JUDGING_STATS_NOTE } from '../../shared/workflow-judging-stats'

export const WORKFLOW_STATS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['workflow', 'stats'],
    summary:
      'Which workflow steps, judges, models and rubrics win, how often JEV escalates, and what it costs',
    usage:
      'omni workflow stats [--template <name>] [--since <date>] [--export | --merge <files> | --blind-review <per-verdict>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'template', 'since', 'export', 'merge', 'blind-review'],
    examples: [
      'omni workflow stats',
      'omni workflow stats --template council --since 2026-09-01',
      'omni workflow stats --json',
      'omni workflow stats --export > studio-discover.json',
      'omni workflow stats --merge studio-discover.json,fleet-discover.json',
      'omni workflow stats --blind-review 10 > blind-review.json'
    ],
    notes: [
      WORKFLOW_JUDGING_STATS_NOTE,
      'Discover adds round yield, cost per step, run reliability, delivery and receipt-backed Start/Dig deeper labels. Unknown bills remain partial. Action labels do not establish precision.',
      '--export writes Discover run measurements to stdout. Collect one snapshot per host with --host/--environment, then --merge the comma-separated files; repeated identical host/run identities count once and conflicting snapshots are refused. Merge is local and never contacts a host.',
      '--blind-review N exports up to N confirmed and N refuted claims with verdicts, votes, action labels and model identities removed. Redirect stdout to save the sample or export.',
      'Reads the judging record kept on this computer, which every settled live run appends to. It never changes the record, and nothing reads these numbers back to change a seat, a rubric or a threshold.',
      'Rounds are grouped by template, step, what decided them (the frozen contract, else the rubric JEV saw) and who judged. Seats are listed by model family, model and system prompt. Gates (set-aside and shortlist screens, the one-answer route, the final check) are listed apart.',
      'Anything the record does not say is "unknown", never 0. Older lines get their JEV method and tokens from their run\'s own ballots file when it has them.',
      "--since takes a date (2026-09-20) or a date and time; --template keeps one template's lines."
    ]
  }
]
