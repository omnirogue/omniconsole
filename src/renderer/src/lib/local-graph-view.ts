import { localRunNodePlacement, type LocalRunNodePlacement } from '../../../shared/local-run-graph'
import type { LocalRunNodeState } from '../../../shared/local-run-node-state'
import type {
  LocalRunQuestionSnapshot,
  LocalRunSnapshot,
  LocalRunStage
} from '../../../shared/local-run-types'
import type { BuildReviewStage } from '../../../shared/build-review-pipeline'
import type { SessionActionPresetId } from '../../../shared/session-action-presets'
import type { SessionEffortParity } from '../../../shared/session-effort-parity'

/**
 * One graph the canvas can draw, projected from rows that already exist: a local Run
 * snapshot, or a Build + Review pipeline. Nothing here computes readiness, schedules
 * anything, or asks a server: it is a view of what the runner already stored.
 *
 * Every node names the workspace FOLDER its worker started in and the files it
 * produced, because that is what a person needs to find the work afterwards. Git is
 * optional, so a folder path is always shown and a branch never is.
 */
export type LocalGraphSource = 'local-run' | 'build-review'

export type LocalGraphActor = {
  agent: string
  model?: string
  effort?: string
  accountChoiceId?: string | null
}

export type LocalGraphNode = {
  id: string
  state: LocalRunNodeState
  actor: LocalGraphActor
  /** What this node asked to run at, beside what its start receipt reported. */
  effortParity?: SessionEffortParity
  presetId: SessionActionPresetId | null
  /** What this node was told to do. Empty for sources that do not store a per-node objective. */
  objective: string
  /** Ids this node depends on. Layout and Mermaid read only these — never the loops. */
  after: string[]
  placement: LocalRunNodePlacement
  /** The folder the worker started in: the workspace root, a run subfolder, or a child workspace. */
  workspacePath: string
  /** Name of the child workspace this node was isolated into, when it had one. */
  childWorkspaceName: string | null
  producedFiles: string[]
  manifestPath: string | null
  reportPath: string | null
  outputDir: string | null
  terminalHandle: string | null
  gateQuestion: string | null
  question: LocalRunQuestionSnapshot | null
  /** Console delivery receipt id, when this node handed its files to a card or person. */
  deliveryId: string | null
  error: string | null
  /** Round this node belongs to, for sources that repeat it. */
  round: number | null
}

/**
 * A repeat edge: the work goes back to `to` after `from` asked for changes. It is kept
 * out of `after` on purpose — the layout is a DAG, and a loop drawn as a dependency
 * would make it a cycle nothing could lay out.
 */
export type LocalGraphLoop = {
  from: string
  to: string
  round: number
  maxRounds: number
}

export type LocalGraphEvent = {
  at: string
  kind: string
  /** Node id, or `run` for the run itself. */
  node: string
  text: string
}

export type LocalGraphView = {
  id: string
  source: LocalGraphSource
  stage: LocalRunStage | BuildReviewStage
  /** Absolute path of the workspace folder this graph ran on. Git optional. */
  workspacePath: string
  workspaceKind: 'folder' | 'git' | null
  /** Terminal handle of the coordinator, when one is open. */
  coordinatorTerminalHandle: string | null
  nodes: LocalGraphNode[]
  loops: LocalGraphLoop[]
  events: LocalGraphEvent[]
  error: string | null
  createdAt: string
  updatedAt: string
}

/** Event lanes, one per node plus the run's own, in the graph's own node order. */
export function localGraphEventLanes(
  view: LocalGraphView
): { node: string; events: LocalGraphEvent[] }[] {
  const lanes = new Map<string, LocalGraphEvent[]>([
    ...view.nodes.map((node) => [node.id, [] as LocalGraphEvent[]] as const),
    ['run', [] as LocalGraphEvent[]]
  ])
  for (const event of view.events) {
    const lane = lanes.get(event.node)
    if (lane) {
      lane.push(event)
    } else {
      // Why keep it: an event for a node this view does not know is still evidence.
      lanes.set(event.node, [event])
    }
  }
  return [...lanes].map(([node, events]) => ({ node, events }))
}

/** The workspace folder a node's worker actually started in. */
function nodeWorkspacePath(run: LocalRunSnapshot, cwd: string | undefined): string {
  return cwd?.trim() || run.workspacePath
}

export function localRunGraphView(run: LocalRunSnapshot): LocalGraphView {
  const definitions = new Map(run.graph.nodes.map((node) => [node.id, node]))
  return {
    id: run.id,
    source: 'local-run',
    stage: run.stage,
    workspacePath: run.workspacePath,
    workspaceKind: run.workspaceKind,
    coordinatorTerminalHandle: run.coordinatorTerminalHandle,
    nodes: run.nodes.map((node) => {
      const definition = definitions.get(node.id)
      return {
        id: node.id,
        state: node.state,
        actor: node.actor,
        ...(node.effortParity ? { effortParity: node.effortParity } : {}),
        presetId: node.presetId,
        objective: definition?.objective ?? '',
        after: definition?.deps ?? [],
        placement: definition ? localRunNodePlacement(definition) : 'local',
        workspacePath: nodeWorkspacePath(run, node.placement?.cwd),
        childWorkspaceName:
          node.placement?.worktree === 'new-child' ? (node.placement.name ?? null) : null,
        producedFiles: node.producedFiles,
        manifestPath: node.manifestPath,
        reportPath: node.reportPath,
        outputDir: node.outputDir,
        terminalHandle: node.terminalHandle,
        gateQuestion: node.gateQuestion,
        question: node.question,
        deliveryId: node.deliveryId,
        error: node.error,
        round: null
      }
    }),
    // A local Run is a DAG the runner walks once: there is no repeat edge to draw,
    // and inventing one would claim a round that never happened.
    loops: [],
    events: run.events.map((event) => ({
      at: event.at,
      kind: event.kind,
      node: event.node,
      text: event.text
    })),
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  }
}
