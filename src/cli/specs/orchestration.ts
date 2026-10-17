import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from './orchestration-worker-specs'
import { ORCHESTRATION_RESULT_SUBMIT_SPEC } from './orchestration-result-spec'
import {
  ORCHESTRATION_TASK_CREATE_SPEC,
  ORCHESTRATION_TASK_TEMPLATES_SPEC
} from './orchestration-task-template-specs'

export const ORCHESTRATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'run-create'],
    summary: 'Create and bind a lightweight orchestration Run',
    usage:
      'omni orchestration run-create --objective <text> [--hub-task-id <btk_id>] [--hub-state-revision <n>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'objective',
      'hub-task-id',
      'hub-state-revision',
      'from',
      'retry-request'
    ],
    notes: [
      'A Run is a namespace and home inbox. It never schedules or places workers.',
      'Outside a managed terminal, pass --from explicitly; the focused terminal is never used as the coordinator.',
      '--hub-task-id binds to a card already created or adopted through omnios; it never creates a card.',
      '--retry-request is only for exact recovery after an unknown mutation result.'
    ]
  },
  {
    path: ['orchestration', 'run-use'],
    summary: 'Bind this coordinator terminal to an existing Run',
    usage:
      'omni orchestration run-use --id <run_id> [--from <handle>] [--takeover-legacy] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'from', 'takeover-legacy', 'retry-request'],
    notes: [
      'Outside a managed terminal, pass --from explicitly; the focused terminal is never used as the coordinator.',
      '--takeover-legacy must run in the live coordinator agent terminal it binds; it preserves existing worker assignments.'
    ]
  },
  {
    path: ['orchestration', 'run-current'],
    summary: 'Show the Run bound to this coordinator terminal',
    usage: 'omni orchestration run-current [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'from']
  },
  {
    path: ['orchestration', 'run-list'],
    summary: 'List lightweight orchestration Runs',
    usage: 'omni orchestration run-list [--limit <n>] [--cursor <cursor>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit', 'cursor']
  },
  {
    path: ['orchestration', 'run-show'],
    summary: 'Show one lightweight orchestration Run',
    usage: 'omni orchestration run-show --id <run_id> [--queue [--limit <n>]] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'queue', 'limit'],
    notes: [
      '--queue lists the unfinished Tasks of the Run (20 by default, 50 at most) with each newest Dispatch and, apart from it, what the worker session shows now. Read-only: it reconciles, stops, retries and releases nothing. Requires orchestration.run-queue.v1.',
      'A row is labelled not-started, blocked, starting, working, quiet, waiting-on-human, waiting-on-coordinator, provider-limited, idle-unreported, unverifiable, exited-unreported, outcome-unknown, failed or failed-session-live. quiet and unverifiable are not exits, and failed-session-live is a failed Dispatch whose session is still live.'
    ]
  },
  {
    path: ['orchestration', 'send'],
    summary: 'Send an inter-agent message',
    usage:
      'omni orchestration send --subject <text> [--to <run:id|dispatch:id|legacy_handle>] [--run <run_id>] [--from <handle>] [--body <text>] [--type <type>] [--priority <level>] [--thread-id <id>] [--payload <json>] [--task-id <id>] [--dispatch-id <id>] [--outcome <succeeded|failed>] [--files-modified <csv>] [--report-path <path>] [--phase <text>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'to',
      'run',
      'from',
      'subject',
      'body',
      'type',
      'priority',
      'thread-id',
      'payload',
      'task-id',
      'dispatch-id',
      'dispatch-capability',
      'retry-request',
      'outcome',
      'files-modified',
      'report-path',
      'phase'
    ],
    notes: [
      'On Windows PowerShell, quote group addresses such as --to "@all" or --to "@worktree:<id>".',
      "worker_done and heartbeat are exact-Dispatch signals and cannot target groups; omit --to to use the Dispatch's Run mailbox.",
      'worker_done requires --outcome succeeded or --outcome failed.',
      'From an active Dispatch, an omitted recipient defaults to its owning Run mailbox.',
      'Use --to dispatch:<id> for attempt-specific coordinator guidance; OmniConsole durably relays it to a connected worker server.',
      'A worker_done with the active task/dispatch IDs completes that task only from the dispatched pane. When stable pane identity is unavailable, the sender handle must exactly match the dispatch assignee; injected preambles include the correct --from value.',
      'Prefer --task-id/--dispatch-id/etc. over raw --payload JSON in worker commands; PowerShell strips JSON quotes easily.'
    ]
  },
  ORCHESTRATION_RESULT_SUBMIT_SPEC,
  {
    path: ['orchestration', 'check'],
    summary: 'Check messages for a terminal',
    usage:
      'omni orchestration check [--terminal <handle>] [--run <run_id>] [--ack <delivery_id>] [--unread | --peek | --all] [--types <type,...>] [--format] [--wait] [--timeout-ms <n>] [--retry-request <id>] [--json]\n' +
      "  default: return the bound Run's oldest unacknowledged FIFO batch.\n" +
      '  --ack: acknowledge the prior whole batch before checking/waiting.\n' +
      '  --peek: return only unread messages without marking them read.\n' +
      '  --all: return every message for the handle; does not mark read.\n' +
      '  --wait: block until a matching message arrives or --timeout-ms expires.\n' +
      '          Emits JSON keepalive lines to stderr every 15s so the caller can\n' +
      '          tell the process is alive. `_keepalive` is unrelated to heartbeat\n' +
      '          messages; `_heartbeat` remains as a deprecated compatibility alias.\n' +
      '          Filter with `jq "select(._keepalive|not)"` when merging streams.',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'terminal',
      'run',
      'ack',
      'unread',
      'peek',
      'all',
      'types',
      'format',
      'wait',
      'timeout-ms',
      'retry-request'
    ],
    notes: [
      'On Windows PowerShell, quote comma-separated type filters, e.g. --types "worker_done,escalation".',
      '--format renders the returned rows as local text only; it never writes to another terminal.',
      'A bound Run replays the same Delivery until --ack; process every message before acknowledging.'
    ]
  },
  {
    path: ['orchestration', 'reply'],
    summary: 'Reply to a message',
    usage:
      'omni orchestration reply --id <msg_id> --body <text> [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'body', 'run', 'from', 'retry-request']
  },
  {
    path: ['orchestration', 'inbox'],
    summary: 'Show messages across (or for) recipients',
    usage: 'omni orchestration inbox [--limit <n>] [--terminal <handle>] [--full] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit', 'terminal', 'full']
  },
  ORCHESTRATION_TASK_CREATE_SPEC,
  ORCHESTRATION_TASK_TEMPLATES_SPEC,
  {
    path: ['orchestration', 'task-list'],
    summary: 'List orchestration tasks',
    usage:
      'omni orchestration task-list [--status <status>] [--ready] [--brief] [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'status', 'ready', 'brief', 'run', 'from'],
    notes: ['--brief collapses whitespace and caps each spec at 160 characters.']
  },
  {
    path: ['orchestration', 'task-update'],
    summary: 'Update a task status',
    usage:
      'omni orchestration task-update --id <task_id> --status <status> [--result <json>] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'status', 'result', 'run', 'from', 'retry-request'],
    notes: ['Valid --status values: pending, ready, dispatched, completed, failed, blocked.']
  },
  ...ORCHESTRATION_WORKER_COMMAND_SPECS,
  {
    path: ['orchestration', 'dispatch'],
    summary: 'Dispatch a task to a terminal',
    usage:
      'omni orchestration dispatch --task <task_id> --to <handle> [--from <handle>] [--run <run_id>] [--inject] [--dry-run] [--return-preamble] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'task',
      'to',
      'from',
      'run',
      'inject',
      'dry-run',
      'return-preamble',
      'retry-request'
    ]
  },
  {
    path: ['orchestration', 'request-show'],
    summary: 'Ask whether one orchestration mutation request already took effect',
    usage: 'omni orchestration request-show --request <request_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'request'],
    notes: [
      'Read-only: it never starts, retries, or settles anything, so it is safe to run after any lost response.',
      'completed means the mutation landed and --retry-request replays the recorded outcome instead of starting a second one. pending means the original mutation is still running or OmniConsole restarted before recording its outcome; wait for a live original command, otherwise replay with --retry-request.',
      'absent means this runtime holds no receipt for that request under your caller identity: it never arrived, it failed before recording anything, or the receipt was pruned. Absent is not proof that nothing happened.'
    ]
  },
  {
    path: ['orchestration', 'dispatch-show'],
    summary: 'Show dispatch context for a task',
    usage:
      'omni orchestration dispatch-show --task <task_id> [--preamble] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'preamble', 'from']
  },
  {
    path: ['orchestration', 'ask'],
    summary: 'Ask the coordinator a question and block until answered',
    usage:
      'omni orchestration ask (--question <text> | --resume <message_id>) [--to <run:id>] [--run <run_id>] [--options <csv>] [--timeout-ms <n>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'to',
      'run',
      'question',
      'resume',
      'dispatch-capability',
      'options',
      'timeout-ms',
      'from',
      'retry-request'
    ],
    notes: [
      'From an active Dispatch, a new question defaults to its owning Run mailbox.',
      'Timeout leaves the question pending; resume with the original message ID.'
    ]
  },
  {
    path: ['orchestration', 'coordinator-start'],
    aliases: [['orchestration', 'run']],
    summary: 'Retired: load the current orchestration skill',
    usage:
      'omni orchestration coordinator-start --spec <text> [--from <handle>] [--poll-interval-ms <n>] [--max-concurrent <n>] [--worktree <selector>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'spec',
      'from',
      'poll-interval-ms',
      'max-concurrent',
      'worktree'
    ],
    notes: [
      'This command performs no effects and returns the exact `skills get orchestration --full` recovery action.',
      'Use the lightweight Run, Task, and worker-start primitives described by the current skill.'
    ]
  },
  {
    path: ['orchestration', 'coordinator-stop'],
    aliases: [['orchestration', 'run-stop']],
    summary: 'Retired: load the current orchestration skill',
    usage: 'omni orchestration coordinator-stop [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'This command performs no effects and returns the exact `skills get orchestration --full` recovery action.'
    ]
  },
  {
    path: ['orchestration', 'gate-create'],
    summary: 'Create a local execution gate blocking a worker step',
    usage:
      'omni orchestration gate-create --task <task_id> --question <text> [--decision-scope execution] [--options <json_array>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'task',
      'question',
      'decision-scope',
      'options',
      'from',
      'retry-request'
    ],
    notes: ['Bound work requires --decision-scope execution. Business decisions belong to omnios.']
  },
  {
    path: ['orchestration', 'gate-resolve'],
    summary: 'Resolve a pending decision gate',
    usage:
      'omni orchestration gate-resolve --id <gate_id> --resolution <text> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'resolution', 'from', 'retry-request']
  },
  {
    path: ['orchestration', 'gate-list'],
    summary: 'List decision gates',
    usage:
      'omni orchestration gate-list [--task <task_id>] [--status <status>] [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'status', 'run', 'from'],
    notes: ['--run inspects a named Run without binding; otherwise gates are scoped to the caller.']
  },
  {
    path: ['orchestration', 'reset'],
    summary: 'Reset one explicit orchestration state scope',
    usage:
      'omni orchestration reset (--all | --tasks | --messages) [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'all', 'tasks', 'messages', 'retry-request']
  }
]
