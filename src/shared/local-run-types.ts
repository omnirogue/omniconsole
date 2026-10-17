import type { LocalRunActor, LocalRunGraph } from './local-run-graph'
import type { LocalRunNodeState } from './local-run-node-state'
import type { SessionActionPresetId } from './session-action-presets'
import type { SessionEffortParity } from './session-effort-parity'

export const LOCAL_RUN_RPC = {
  create: 'localRun.create',
  start: 'localRun.start',
  status: 'localRun.status',
  list: 'localRun.list',
  resolveGate: 'localRun.resolveGate',
  reply: 'localRun.reply',
  cancel: 'localRun.cancel',
  saveDraft: 'localRun.saveDraft',
  listDrafts: 'localRun.listDrafts',
  removeDraft: 'localRun.removeDraft'
} as const

/** Preload/IPC channel carrying `LocalRunChangedPayload` main → renderer. */
export const LOCAL_RUN_CHANGED_CHANNEL = 'localRun:changed'

export type LocalRunStage =
  | 'created'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type LocalRunPlacementSnapshot = {
  /** `current`, `new-child`, or an exact existing workspace selector. */
  worktree: string
  name?: string
  /** Folder inside the workspace this node's worker started in. */
  cwd?: string
}

export type LocalRunQuestionSnapshot = {
  /**
   * What `localRun.reply` answers. For a `mailbox` question this is the orchestration
   * question message id; for a `terminal` one it is a synthetic id pinned to the turn
   * the agent stopped in, so a person's reply cannot land on a different turn.
   */
  messageId: string
  /**
   * Where the answer has to go. `mailbox`: the worker sent an ask through the Run
   * mailbox and is blocked on it. `terminal`: the worker stopped in its own terminal
   * with no ask, so the answer is delivered as a prompt to that terminal.
   */
  source: 'mailbox' | 'terminal'
  question: string
  options: string[]
  askedAt: string
}

export type LocalRunNodeSnapshot = {
  id: string
  actor: LocalRunActor
  /** What this node asked to run at, beside what its start receipt reported. */
  effortParity?: SessionEffortParity
  presetId: SessionActionPresetId
  state: LocalRunNodeState
  taskId: string | null
  dispatchId: string | null
  terminalHandle: string | null
  placement: LocalRunPlacementSnapshot | null
  /** The path the runner dictated; the worker was told to write exactly this. */
  reportPath: string | null
  outputDir: string | null
  manifestPath: string | null
  producedFiles: string[]
  /**
   * The gate opened for this node, if any. It stays set after the gate is answered:
   * it records that the gate was already opened. Offer a resolve affordance only
   * while `state` is `needs-input`.
   */
  gateId: string | null
  gateQuestion: string | null
  question: LocalRunQuestionSnapshot | null
  /** Console delivery receipt id, when this node delivered its files. */
  deliveryId: string | null
  error: string | null
}

export type LocalRunEvent = {
  at: string
  kind: 'info' | 'error' | 'node' | 'gate' | 'deliver'
  node: string
  text: string
}

export type LocalRunSnapshot = {
  id: string
  /** Orchestration Run id. Unadmitted: never bound to a card. */
  runId: string | null
  workspacePath: string
  workspaceId: string | null
  workspaceKind: 'folder' | 'git'
  coordinatorTerminalHandle: string | null
  stage: LocalRunStage
  maxConcurrent: number
  graph: LocalRunGraph
  nodes: LocalRunNodeSnapshot[]
  events: LocalRunEvent[]
  error: string | null
  createdAt: string
  updatedAt: string
}

export type LocalRunChangedPayload = { localRunId: string; stage: LocalRunStage }

export function isLocalRunActive(stage: LocalRunStage): boolean {
  return stage === 'created' || stage === 'starting' || stage === 'running'
}
