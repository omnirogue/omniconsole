import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const ORCHESTRATION_WORKER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'worker-start'],
    summary: 'Start one supervised worker on the Run home or a connected OmniConsole server',
    usage:
      'omni orchestration worker-start --task <task_id> [--on <saved-environment>] [--worktree <current|selector|new-child|new-top-level>] (--agent <agent> | --terminal <handle>) [--model <id>] [--effort <level>] [--name <name>] [--repo <selector>] [--base-branch <ref>] [--display-name <text>] [--comment <text>] [--setup <run|skip|inherit>] [--retry-of <dispatch_id>] [--close-on-completion | --keep-as-conversation] [--timeout-ms <n>] [--project <folder> | --no-project] [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'task',
      'on',
      'worktree',
      'name',
      'repo',
      'base-branch',
      'display-name',
      'comment',
      'setup',
      'agent',
      'model',
      'effort',
      'terminal',
      'retry-of',
      'timeout-ms',
      'run',
      'from',
      'retry-request',
      'project',
      'no-project',
      'close-on-completion',
      'keep-as-conversation'
    ],
    notes: [
      'New local Claude and Codex workers default to durable release after the coordinator acknowledges their final report. Protected or unverifiable owner facts hold cleanup; --on, --terminal, other agents and older dispatches retain their existing lifecycle. --keep-as-conversation opts out at launch; worker-retain records a later durable exception. --close-on-completion keeps the explicit policy and requires orchestration.worker-completion-policy.v1.',
      'Generic agent or terminal launches remain conversations until they register an exact worker Dispatch with a Run completion mailbox; transcript or idle state alone cannot authorize cleanup.',
      'Current and existing worktrees never rerun setup; a fresh agent terminal is created unless --terminal is explicit.',
      'When reusing --terminal, pass --worktree for that terminal; current means the coordinator worktree.',
      '--model supports Claude, Codex, and Cursor opaque provider model ids; --effort requires --model. Neither can combine with --terminal.',
      'New worktrees use agent-first creation and default --setup to run. Repository start-immediately runs setup beside the agent; wait-for-setup gates agent readiness and task input.',
      'Creation flags (--name, --repo, --base-branch, --display-name, --comment, --setup) are rejected for current/existing worktrees. Use exact --repo on the selected server; project/host convenience routing remains on worktree create.',
      '--on selects only the worker server; the Run and this command remain on the current OmniConsole server.',
      'Remote current and new-child are invalid; discover an exact remote selector or use new-top-level.',
      '--retry-of links the replacement attempt but does not inherit placement; repeat the intended --on/worktree and --agent/terminal choices.',
      'The call exits 0 only for ready. Failed or outcome_unknown exits 1 and JSON includes stage/failedStage, setup, effects, residualResources, and recovery commands when needed.',
      "A worker joins its coordinator's project when the coordinator is one of the project's threads (filed in it, its project chat, or a worker one of those started): its task arrives after the project line and context, resolved for the computer it runs on, and stays unfiled under its coordinator. JSON project names it, with notOnHost for items that computer lacks. --project <folder> names a project from outside (a Conversations folder in it, by id or path) and files the worker there; --no-project starts it without one. A worker started with --on gets the same project line and context in its task text, resolved for that computer, and is never filed here. Without an OmniConsole window the worker starts without its project and project.notInherited says why. A runtime without orchestration.worker-project.v1 refuses both flags.",
      'Without --on, a project whose Computers list puts a paired computer first sends the worker there when it can move (--worktree new-top-level with --name and --repo); the project lines say which computer ran it, or why it stayed here.'
    ]
  },
  {
    path: ['orchestration', 'worker-prepare'],
    summary: 'Prepare a canonical worker blocked until its Hub start receipt',
    usage:
      'omni orchestration worker-prepare --task <task_id> --run <run_id> --worktree <selector> --execution-file <path> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'task',
      'run',
      'from',
      'worktree',
      'execution-file',
      'retry-request'
    ],
    notes: [
      'Requires a runtime advertising orchestration-canonical-start-barrier-v1.',
      'The execution file belongs to the runtime host; the CLI forwards its path without reading its contents.',
      'A prepared worker remains starting and exits 0. Inspect canonical process identity before requesting its Hub start receipt.'
    ]
  },
  {
    path: ['orchestration', 'worker-execute'],
    summary: 'Execute a prepared canonical worker after its Hub start receipt',
    usage:
      'omni orchestration worker-execute --dispatch <dispatch_id> --start-receipt-file <path> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'start-receipt-file', 'retry-request'],
    notes: [
      'Requires a runtime advertising orchestration-canonical-start-barrier-v1.',
      'The start receipt file belongs to the runtime host; the CLI forwards its path without reading its contents.',
      'The call exits 0 only when the worker is ready.'
    ]
  },
  {
    path: ['orchestration', 'worker-show'],
    summary: 'Inspect one supervised worker Dispatch',
    usage:
      'omni orchestration worker-show --dispatch <dispatch_id> [--receipt] [--observe-provider] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'receipt', 'observe-provider'],
    notes: [
      '--receipt joins the exact Run, Task and Dispatch without reconciling execution state; requires orchestration-worker-outcome-receipt-v1. A linked HUB card adds one bounded task read. --observe-provider requires --receipt and adds one bounded exact transcript read on the execution owner.',
      'Receipt phase durations, account category, usage, cost and independently accepted quality remain null when evidence is missing. Recorded elapsed intervals include several phases. HUB verification is task-scoped and does not prove this attempt was independently accepted.',
      'Measured startup spans Dispatch creation to acknowledged task input on the Run home monotonic clock, including setup and readiness. Older, federated and canonical starts without this recorded observation report null.',
      'A Dispatch created by orchestration dispatch is shown as unsupervised and reports the exact adopted terminal when its identity is still provable.',
      'observation.agentWait names a worker parked on a prompt only a human can answer, with the evidence that proved it (hook, prompt-text, or title). Null means OmniConsole looked and found no wait. An absent field means it never looked — an older host, an unverifiable worker identity, an unreadable pane, or an agent probe that did not answer in time — and never means the worker is not waiting. A waiting worker is healthy, not failed.'
    ]
  },
  {
    path: ['orchestration', 'worker-read'],
    summary: 'Read bounded output from one supervised worker',
    usage:
      'omni orchestration worker-read --dispatch <dispatch_id> [--source <auto|transcript|terminal>] [--cursor <cursor>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'source', 'cursor', 'limit'],
    notes: [
      'The default auto source uses an exact hook-reported transcript when available and otherwise returns labeled terminal output.',
      'A Dispatch created by orchestration dispatch reads from its adopted terminal with worker status unsupervised.',
      'A returned cursor is pinned to the exact source; start a fresh read if OmniConsole reports source_changed.'
    ]
  },
  {
    path: ['orchestration', 'worker-stop'],
    summary: 'Fence one Dispatch and stop its supervised agent terminal',
    usage:
      'omni orchestration worker-stop --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    notes: [
      'A Dispatch created by orchestration dispatch is fenced without closing its unsupervised terminal process.',
      'Never deletes the worktree, setup terminal, configured tabs, or unrelated processes.'
    ]
  },
  {
    path: ['orchestration', 'worker-abandon'],
    summary: 'Fence a worker without claiming its process stopped',
    usage:
      'omni orchestration worker-abandon --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    notes: ['Retains all possibly-live resources and performs no process or filesystem action.']
  },
  {
    path: ['orchestration', 'worker-release'],
    summary: 'Release the terminal of one settled supervised worker',
    usage:
      'omni orchestration worker-release --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    notes: [
      'Post-completion cleanup for a settled (succeeded or failed) worker; closes only the exact coordinator-owned agent terminal of that worker.',
      'A settled Dispatch created by orchestration dispatch has no owned terminal resource and is reported retained without process action.',
      'An inspectable output archive is preserved before the terminal closes, so worker-read still returns output afterwards.',
      'Never closes setup terminals, configured tabs, reused or pre-existing terminals, user-taken-over terminals, or unproven identities.',
      'Idempotent: repeating the call reports already_released. Only release_unknown exits 1; retained, release_pending, and already_released exit 0.'
    ]
  },
  {
    path: ['orchestration', 'worker-retain'],
    summary: 'Keep one supervised worker terminal live for debugging',
    usage:
      'omni orchestration worker-retain --dispatch <dispatch_id> [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'retry-request'],
    notes: [
      'Records a durable user-requested exception; a later explicit worker-release clears it and releases the terminal.',
      'A settled Dispatch created by orchestration dispatch has no owned terminal resource and is reported retained without process action.',
      'Performs no process or filesystem action.'
    ]
  },
  {
    path: ['orchestration', 'worker-list'],
    summary: 'List supervised worker terminal resource accounting',
    usage:
      'omni orchestration worker-list [--run <run_id>] [--terminal-state <active|reclaimable|retained|release_pending|release_unknown|released>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'terminal-state'],
    notes: [
      'Terminal state is process accounting and is reported separately from Task status; a completed Task can still own a live terminal.',
      'Context-only Dispatches created by orchestration dispatch are included as unsupervised with terminal state retained.'
    ]
  }
]
