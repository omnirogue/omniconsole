import { randomUUID } from 'node:crypto'
import type { LocalRunGraph, LocalRunNode } from '../../../shared/local-run-graph'
import { localRunNodesInLevelOrder } from '../../../shared/local-run-node-state'
import type {
  LocalRunEvent,
  LocalRunNodeSnapshot,
  LocalRunSnapshot,
  LocalRunStage
} from '../../../shared/local-run-types'
import type { WorkerUnitLike } from './build-review-worker-registry'

const MAX_EVENTS = 400

function now(): string {
  return new Date().toISOString()
}

/**
 * One node's worker seen as a WorkerUnitLike, so the shared registry, mailbox fold
 * and lifecycle drive it without knowing anything about graphs.
 */
export type LocalRunWorkerUnit = WorkerUnitLike & { nodeId: string }

export function createLocalRunWorkerUnit(node: LocalRunNode): LocalRunWorkerUnit {
  return {
    nodeId: node.id,
    role: node.id,
    choice: {
      agent: node.actor.agent,
      ...(node.actor.model ? { model: node.actor.model } : {}),
      ...(node.actor.effort ? { effort: node.actor.effort } : {})
    },
    status: 'pending',
    taskId: null,
    dispatchId: null,
    terminalHandle: null,
    report: null,
    error: null
  }
}

export function createLocalRunSnapshot(args: {
  graph: LocalRunGraph
  workspaceKind: 'folder' | 'git'
  maxConcurrent: number
}): LocalRunSnapshot {
  const at = now()
  return {
    id: `lrn_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    runId: null,
    workspacePath: args.graph.workspacePath,
    workspaceId: null,
    workspaceKind: args.workspaceKind,
    coordinatorTerminalHandle: null,
    stage: 'created',
    maxConcurrent: args.maxConcurrent,
    graph: args.graph,
    nodes: localRunNodesInLevelOrder(args.graph).map((node) => ({
      id: node.id,
      actor: node.actor,
      presetId: node.presetId,
      state: 'queued',
      taskId: null,
      dispatchId: null,
      terminalHandle: null,
      placement: null,
      reportPath: null,
      outputDir: null,
      manifestPath: null,
      producedFiles: [],
      gateId: null,
      gateQuestion: node.gate?.question ?? null,
      question: null,
      deliveryId: null,
      error: null
    })),
    events: [],
    error: null,
    createdAt: at,
    updatedAt: at
  }
}

export function localRunNodeSnapshot(
  snapshot: LocalRunSnapshot,
  nodeId: string
): LocalRunNodeSnapshot {
  const node = snapshot.nodes.find((entry) => entry.id === nodeId)
  if (!node) {
    throw new Error(`Node ${nodeId} is not part of this run.`)
  }
  return node
}

export function pushLocalRunEvent(
  snapshot: LocalRunSnapshot,
  kind: LocalRunEvent['kind'],
  node: string,
  text: string
): void {
  snapshot.events.push({ at: now(), kind, node, text })
  if (snapshot.events.length > MAX_EVENTS) {
    snapshot.events.splice(0, snapshot.events.length - MAX_EVENTS)
  }
  snapshot.updatedAt = now()
}

export function setLocalRunStage(snapshot: LocalRunSnapshot, stage: LocalRunStage): void {
  snapshot.stage = stage
  snapshot.updatedAt = now()
}

export function cloneLocalRunSnapshot(snapshot: LocalRunSnapshot): LocalRunSnapshot {
  return structuredClone(snapshot)
}
