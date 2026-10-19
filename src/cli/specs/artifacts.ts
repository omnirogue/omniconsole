import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const CLOUD_FLAGS = ['api-url']
const REVIEW_FLAGS = [
  'review',
  'question',
  'reviewers',
  'category',
  'audience',
  'proposal-json',
  'summary',
  'option',
  'recommend',
  'multi',
  'keep-session'
]
const REVIEW_USAGE =
  '[--review] [--question <text>] [--reviewers <email|emp_id,...>] [--category <slug>] [--audience team|reviewers|public] [--proposal-json <json>] [--summary <text>] [--option "<label>[::detail]"]... [--recommend <label>] [--multi] [--keep-session]'
const REVIEW_SLEEP_NOTE =
  'Published for review from an OmniConsole agent session, the session waits live for a decision (Settings → Artifacts, 60 minutes by default), then sleeps; a decision on the page wakes the same conversation. --keep-session keeps it running instead.'

const REVIEW_OPTIONS_NOTE =
  'Repeat --option (2 to 8) for one-click answers; --recommend marks one (several with --multi, which lets the reviewer pick more than one). --option cannot be combined with --proposal-json.'

const REVIEW_CATEGORY_NOTE =
  '--category <slug>: What it is about, which decides who may answer it: customer-service, finance (refunds, payments, billing), sales, operations, models, queue, advertising or development. Anything else, or none, is filed under Other.'

const LIFECYCLE_COMPAT_NOTE =
  'An older OmniConsole server without page lifecycle supports neither form. Over SSH with a lifecycle-capable server, an older relay supports only the page id form.'

export const ARTIFACT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['artifacts', 'share'],
    summary: 'Share an HTML or Markdown file with your OmniConsole account',
    usage: `omni artifacts share <file> ${REVIEW_USAGE} [--api-url <url>] [--json]`,
    allowedFlags: [...GLOBAL_FLAGS, ...CLOUD_FLAGS, ...REVIEW_FLAGS, 'file'],
    positionalArgs: ['file'],
    examples: [
      'omni artifacts share ./report.html',
      'omni artifacts share ./notes.md --json',
      'omni artifacts share ./launch-plan.html --question "Approve this ad launch?" --json',
      'omni artifacts share ./fix.html --question "Fix the checkout bug?" --summary "Two lines a person can decide from." --option "Start::Open a PR today" --option "Not now" --recommend Start --json'
    ],
    notes: [REVIEW_SLEEP_NOTE, REVIEW_OPTIONS_NOTE, REVIEW_CATEGORY_NOTE]
  },
  {
    path: ['artifacts', 'update'],
    summary: 'Update a file previously shared from this OmniConsole profile',
    usage: `omni artifacts update <file> ${REVIEW_USAGE} [--api-url <url>] [--json]`,
    allowedFlags: [...GLOBAL_FLAGS, ...CLOUD_FLAGS, ...REVIEW_FLAGS, 'file'],
    positionalArgs: ['file'],
    notes: [REVIEW_SLEEP_NOTE, REVIEW_OPTIONS_NOTE, REVIEW_CATEGORY_NOTE]
  },
  {
    path: ['artifacts', 'status'],
    summary: 'Show the review status and latest decision of a shared artifact',
    usage: 'omni artifacts status <file-or-id> [--wait <seconds>] [--api-url <url>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...CLOUD_FLAGS, 'file', 'wait', 'wait-seconds'],
    // Why: `--wait` is a global boolean flag, so its seconds arrive as a second positional.
    positionalArgs: ['file', 'wait-seconds'],
    examples: [
      'omni artifacts status ./launch-plan.html --json',
      'omni artifacts status ./launch-plan.html --wait 300 --json'
    ],
    notes: [
      '--wait returns on a decision, a closed or superseded page, or once a review or study has its responses in (printed as `status: responses_in`; with --json, `status` stays `pending` and `progress.ready` is true). The answers are in the JSON `responses` field.'
    ]
  },
  {
    path: ['artifacts', 'close-review'],
    summary: 'Withdraw your own pending review, e.g. a question answered elsewhere',
    usage: 'omni artifacts close-review <file-or-id> [--reason <text>] [--api-url <url>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...CLOUD_FLAGS, 'file', 'reason'],
    positionalArgs: ['file'],
    examples: [
      'omni artifacts close-review ./question.html --reason "Answered in the terminal" --json'
    ],
    notes: [
      'Only the page owner can close it. It leaves the Decisions list, and a decision sent afterwards is refused.'
    ]
  },
  {
    path: ['artifacts', 'close'],
    summary:
      'Close your own review page as done (with where the result is) or as needing no action',
    usage:
      'omni artifacts close <file-or-id> (--done [--ref <url>] | --no-action) [--revision <n>] [--expect-open] [--note <text>] [--api-url <url>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      ...CLOUD_FLAGS,
      'file',
      'done',
      'no-action',
      'ref',
      'note',
      'revision',
      'expect-open'
    ],
    positionalArgs: ['file'],
    examples: [
      'omni artifacts close ./launch-plan.html --done --ref https://github.com/org/repo/pull/12 --json',
      'omni artifacts close ./question.html --no-action --note "Answered in the terminal" --json'
    ],
    notes: [
      'Only the page owner can close it, and --done needs an approval on the current revision; a review or study needs none (its owner closes it --done, with the conclusion as the note, once the answers are read; a study anyone answered cannot be reopened). A closed page leaves the Decisions list and refuses a late decision; publishing a new revision reopens it.',
      'For a decision answered elsewhere, pass its exact --revision and --expect-open with an evidence note. A newer or already closed page is refused; a closure never records an approval.',
      LIFECYCLE_COMPAT_NOTE
    ]
  },
  {
    path: ['artifacts', 'supersede'],
    summary: 'Mark your page as replaced by a newer page',
    usage:
      'omni artifacts supersede <file-or-id> --by <id-or-url> [--revision <n>] [--expect-unsuperseded] [--api-url <url>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      ...CLOUD_FLAGS,
      'file',
      'by',
      'revision',
      'expect-unsuperseded'
    ],
    positionalArgs: ['file'],
    examples: [
      'omni artifacts supersede ./plan-v1.html --by https://app.omnisi.ai/a/plan-v2 --json'
    ],
    notes: [
      'Any page you own can be superseded, including a plain share or a closed page. The successor must be a live page you can view.',
      LIFECYCLE_COMPAT_NOTE
    ]
  },
  {
    path: ['artifacts', 'reopen'],
    summary: 'Undo closing your page (done or no action)',
    usage: 'omni artifacts reopen <file-or-id> [--api-url <url>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...CLOUD_FLAGS, 'file'],
    positionalArgs: ['file'],
    examples: ['omni artifacts reopen ./launch-plan.html --json'],
    notes: [
      'Reopens only the closure it just read; if the page changed meanwhile the server refuses.',
      LIFECYCLE_COMPAT_NOTE
    ]
  },
  {
    path: ['artifacts', 'unsupersede'],
    summary: 'Remove the successor from your page',
    usage: 'omni artifacts unsupersede <file-or-id> [--api-url <url>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...CLOUD_FLAGS, 'file'],
    positionalArgs: ['file'],
    examples: ['omni artifacts unsupersede ./plan-v1.html --json'],
    notes: [
      'Removes only the successor it just read; if the page changed meanwhile the server refuses.',
      LIFECYCLE_COMPAT_NOTE
    ]
  },
  {
    path: ['artifacts', 'unshare'],
    destructive: true,
    summary: 'Delete the artifact associated with a previously shared file',
    usage: 'omni artifacts unshare <file> [--api-url <url>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...CLOUD_FLAGS, 'file'],
    positionalArgs: ['file']
  },
  {
    path: ['artifacts', 'list'],
    summary: 'List artifacts owned by the signed-in OmniConsole account',
    usage: 'omni artifacts list [--cursor <cursor>] [--api-url <url>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...CLOUD_FLAGS, 'cursor']
  },
  {
    path: ['artifacts', 'delete'],
    aliases: [['artifacts', 'rm']],
    destructive: true,
    summary: 'Delete an artifact owned by the signed-in OmniConsole account',
    usage: 'omni artifacts delete <id> [--api-url <url>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...CLOUD_FLAGS, 'id'],
    positionalArgs: ['id']
  }
]
