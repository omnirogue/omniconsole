import type {
  LocalWorkflowDraft,
  LocalWorkflowPreset,
  LocalWorkflowScopeOption
} from './local-workflow-draft'
import type {
  LocalWorkflowRoute,
  LocalWorkflowSeatCatalog,
  LocalWorkflowSeatChoice
} from './local-workflow-seats'
import type { LocalWorkflowAction, LocalWorkflowView } from './local-workflow-view'
import type { WorkflowPlacement } from './local-workflow-placement'
import type { LocalWorkflowVerifiedFinding } from './local-workflow-graph-view'

export const LOCAL_WORKFLOW_METHODS = {
  models: 'localWorkflow.models',
  listModelPresets: 'localWorkflow.listModelPresets',
  saveModelPreset: 'localWorkflow.saveModelPreset',
  deleteModelPreset: 'localWorkflow.deleteModelPreset',
  /** The Cheap / Standard / Frontier lineups: the person's own, or the built-in ones. */
  modelTiers: 'localWorkflow.modelTiers',
  saveModelTiers: 'localWorkflow.saveModelTiers',
  setup: 'localWorkflow.setup',
  start: 'localWorkflow.start',
  show: 'localWorkflow.show',
  control: 'localWorkflow.control',
  /** Streaming: emits LocalWorkflowWatchEvent until unsubscribed. */
  watch: 'localWorkflow.watch',
  /** One call's captured logs, on demand. */
  readCall: 'localWorkflow.readCall',
  /** One run's tab and sidebar status, read without recovering or resuming it. */
  status: 'localWorkflow.status',
  /** `omni find-best`: the window opens a Find the best conversation and starts it. */
  find: 'localWorkflow.find',
  /** `omni workflow run`: the window opens a conversation for a built-in template and starts it. */
  run: 'localWorkflow.run',
  /** `omni workflow stats`: the judging record summed up, read from this host's own records. */
  stats: 'localWorkflow.stats',
  /** `omni workflow status <run-id>`: state, placement, requester and each seat's session. */
  runStatus: 'localWorkflow.runStatus',
  discoverDeliver: 'localWorkflow.discoverDeliver',
  /** The fleet hosts a person may pick as "Run on: <host>". */
  fleetHosts: 'localWorkflow.fleetHosts'
} as const

/** Pushed views omit stdout/stderr; the renderer reads them through readCall. */
export type LocalWorkflowWatchEvent = { type: 'view'; view: LocalWorkflowView }
export type LocalWorkflowReadCallRequest = LocalWorkflowAddress & {
  executionId: string
  callId: string
}
export type LocalWorkflowReadCallResult = {
  stdout: string
  stderr: string
  outputTruncated: boolean
  /** Attempt the logs came from; absent while the call has no captured logs. */
  attempt?: number
}
/** Window broadcast so tab strips and sidebars update while the conversation is hidden. */
export type LocalWorkflowChangedEvent = {
  conversationId: string
  executionId: string
  /** `evolve`: an Evolve run's record (evolve-workflow.ts), keyed by its `evo_` id. */
  preset: LocalWorkflowPreset | 'evolve'
  state: LocalWorkflowView['state']
  running: number
  completed: number
  total: number
  phase?: string
  /** The machine the run was placed on, for the row's caption; absent when it ran here by choice. */
  host?: string
  /** SSH alias frozen at admission for dispatched workers; never the controller identity. */
  sshHost?: string
  /** Who asked an agent to start the run. */
  requestedBy?: string
  requestedById?: string
}

/** One launched attempt of a run: where it ran and the CLI session it answered in. */
export type LocalWorkflowRunStatusSeat = {
  callId: string
  attempt: number
  state: string
  route?: LocalWorkflowRoute
  model?: string
  /** The fleet host's name, or "this computer". */
  host: string
  /** The attempt's own folder on a fleet host. */
  remoteDirectory?: string
  /** The provider session the answer came from (Claude's is the attempt id). */
  sessionId?: string
  error?: string
}

/** `omni workflow status <run-id>`: one run by id, read without recovering or resuming it. */
export type LocalWorkflowRunStatus = {
  executionId: string
  worktreeId: string
  conversationId: string
  preset: LocalWorkflowPreset
  state: LocalWorkflowView['state']
  prompt: string
  startedAt: number
  finishedAt?: number
  error?: string
  placement?: WorkflowPlacement
  requestedBy?: string
  requestedById?: string
  request?: string
  seats: LocalWorkflowRunStatusSeat[]
  /** Runs that review items one by one: each finding confirmed so far, as soon as it is. */
  verified?: { count: number; items: LocalWorkflowVerifiedFinding[] }
  /** A Discover run brought to OmniOS: its delivering session's state and, once shared, the page. */
  omnios?: { state: string; at?: string; attempts?: number; error?: string; url?: string }
}

/** The hosts "Run on: <host>" offers: heavy-work rows of the estate hosts file. */
export type LocalWorkflowFleetHosts = {
  path: string
  hosts: { name: string; machine: string; hostname: string; ssh: string | null; local: boolean }[]
}

export type LocalWorkflowAddress = { worktree: string; conversationId: string }
export type LocalWorkflowSetupRequest = LocalWorkflowAddress & { preset: LocalWorkflowPreset }
export type LocalWorkflowSetupResult = {
  /** Absent on hosts that cannot admit Audit; clients must not substitute another preset. */
  auditSupport?: { version: 1; unavailableReason?: string }
  auditTeam?: LocalWorkflowSeatChoice[]
  executionId?: string
  catalog: LocalWorkflowSeatCatalog[]
  defaults?: LocalWorkflowDraft
  scopeLabel: string
  scopeOptions: LocalWorkflowScopeOption[]
  maxConcurrency: number
  unavailableReason?: string
  /** One seat choice per available model family (`id` = the family) for workflow graphs. */
  graphTeam?: LocalWorkflowSeatChoice[]
}
export type LocalWorkflowStartRequest = LocalWorkflowSetupRequest & {
  requestId: string
  draft: LocalWorkflowDraft
}
/** Rejected is proof of no admission; ambiguous failures must remain RPC errors. */
export type LocalWorkflowStartResult = { executionId: string } | { rejected: true; reason: string }
export type LocalWorkflowShowRequest = LocalWorkflowAddress & { executionId: string }
export type LocalWorkflowSaveResultRequest = LocalWorkflowShowRequest
export type LocalWorkflowSaveResult =
  | { saved: false; cancelled: true }
  | { saved: true; filePath: string; executionId: string; sha256: string }
export type LocalWorkflowControlRequest = LocalWorkflowShowRequest & {
  fence: number
  action: LocalWorkflowAction
}
export type LocalWorkflowShowResult = LocalWorkflowView
export type LocalWorkflowControlResult = LocalWorkflowView
