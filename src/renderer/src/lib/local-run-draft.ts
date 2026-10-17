import {
  LOCAL_RUN_MAX_CONCURRENT,
  LOCAL_RUN_MAX_NODES,
  normalizeLocalRunGraph,
  type LocalRunDraft,
  type LocalRunGraph,
  type LocalRunNodePlacement
} from '../../../shared/local-run-graph'
import { localRunTemplateGraph, type LocalRunTemplateId } from '../../../shared/local-run-templates'
import type { SessionActionPresetId } from '../../../shared/session-action-presets'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LocalGraphView } from './local-graph-view'

/**
 * A graph a person is authoring on the canvas, before anything runs. One node is an
 * actor (agent, model, effort, account) plus an action preset, an optional gate and a
 * placement; one edge is a dependency. The workspace is a folder — git is optional and
 * only decides whether the graph could also be admitted through the console.
 */
export type LocalRunDraftNode = {
  id: string
  presetId: SessionActionPresetId
  objective: string
  agent: TuiAgent
  model: string
  effort: string
  /** `managed:<id>` / `profile:<id>`; null means the account the CLI is signed into. */
  accountChoiceId: string | null
  gate: boolean
  gateQuestion: string
  placement: LocalRunNodePlacement
  deps: string[]
}

export type LocalRunCanvasDraft = {
  id: string
  title: string
  /** Absolute path of the workspace folder. */
  workspacePath: string
  /** Runtime selector for the same workspace; decides whose CLIs are asked for models. */
  workspaceSelector: string
  workspaceKind: 'folder' | 'git'
  maxConcurrent: number
  nodes: LocalRunDraftNode[]
}

export const LOCAL_RUN_DRAFT_DEFAULT_AGENT: TuiAgent = 'codex'

export function newLocalRunDraftNode(
  id: string,
  patch: Partial<LocalRunDraftNode> = {}
): LocalRunDraftNode {
  return {
    id,
    presetId: 'implement',
    objective: '',
    agent: LOCAL_RUN_DRAFT_DEFAULT_AGENT,
    model: '',
    effort: '',
    accountChoiceId: null,
    gate: false,
    gateQuestion: '',
    placement: 'local',
    deps: [],
    ...patch
  }
}

export function newLocalRunDraft(
  workspace: { path: string; selector: string; kind: 'folder' | 'git' },
  patch: Partial<LocalRunCanvasDraft> = {}
): LocalRunCanvasDraft {
  return {
    id: `draft-${Date.now().toString(36)}`,
    title: '',
    workspacePath: workspace.path,
    workspaceSelector: workspace.selector,
    workspaceKind: workspace.kind,
    maxConcurrent: 3,
    nodes: [newLocalRunDraftNode('step-1')],
    ...patch
  }
}

/** The next free `step-n` id; ids are stable once created, so edges never dangle. */
export function nextLocalRunDraftNodeId(draft: LocalRunCanvasDraft): string {
  let index = draft.nodes.length + 1
  while (draft.nodes.some((node) => node.id === `step-${index}`)) {
    index += 1
  }
  return `step-${index}`
}

export function addLocalRunDraftNode(
  draft: LocalRunCanvasDraft,
  patch: Partial<LocalRunDraftNode> = {}
): LocalRunCanvasDraft {
  if (draft.nodes.length >= LOCAL_RUN_MAX_NODES) {
    return draft
  }
  return {
    ...draft,
    nodes: [...draft.nodes, newLocalRunDraftNode(nextLocalRunDraftNodeId(draft), patch)]
  }
}

export function removeLocalRunDraftNode(
  draft: LocalRunCanvasDraft,
  nodeId: string
): LocalRunCanvasDraft {
  return {
    ...draft,
    nodes: draft.nodes
      .filter((node) => node.id !== nodeId)
      .map((node) => ({ ...node, deps: node.deps.filter((dep) => dep !== nodeId) }))
  }
}

export type LocalRunDraftEdit = { draft: LocalRunCanvasDraft; error: string | null }

/**
 * Connect two steps. The runner's own normalizer decides whether the result is still a
 * finite DAG, so the canvas cannot author a graph the runner would refuse — and the
 * person is told at the moment they draw the edge, not when they press Run.
 */
export function connectLocalRunDraftNodes(
  draft: LocalRunCanvasDraft,
  fromId: string,
  toId: string,
  cycleMessage: string
): LocalRunDraftEdit {
  if (fromId === toId || !draft.nodes.some((node) => node.id === fromId)) {
    return { draft, error: cycleMessage }
  }
  const next = {
    ...draft,
    nodes: draft.nodes.map((node) =>
      node.id === toId && !node.deps.includes(fromId)
        ? { ...node, deps: [...node.deps, fromId] }
        : node
    )
  }
  return normalizeLocalRunGraph(localRunDraftGraph(next))
    ? { draft: next, error: null }
    : { draft, error: cycleMessage }
}

export function disconnectLocalRunDraftNodes(
  draft: LocalRunCanvasDraft,
  fromId: string,
  toId: string
): LocalRunCanvasDraft {
  return {
    ...draft,
    nodes: draft.nodes.map((node) =>
      node.id === toId ? { ...node, deps: node.deps.filter((dep) => dep !== fromId) } : node
    )
  }
}

/** The exact `localRun.create` payload for this draft. */
export function localRunDraftGraph(draft: LocalRunCanvasDraft): LocalRunGraph {
  return {
    workspacePath: draft.workspacePath,
    maxConcurrent: Math.min(Math.max(draft.maxConcurrent, 1), LOCAL_RUN_MAX_CONCURRENT),
    nodes: draft.nodes.map((node) => ({
      id: node.id,
      actor: {
        agent: node.agent,
        ...(node.model.trim() ? { model: node.model.trim() } : {}),
        ...(node.effort.trim() ? { effort: node.effort.trim() } : {}),
        ...(node.accountChoiceId ? { accountChoiceId: node.accountChoiceId } : {})
      },
      presetId: node.presetId,
      objective: node.objective.trim(),
      ...(node.gate && node.gateQuestion.trim()
        ? { gate: { question: node.gateQuestion.trim() } }
        : {}),
      ...(node.placement === 'fleet' ? { placement: 'fleet' as const } : {}),
      deps: node.deps
    }))
  }
}

/** What the canvas saves beside automations: Phase 2's own draft domain. */
export function localRunDraftSaveParams(draft: LocalRunCanvasDraft): {
  id: string
  title: string
  graph: LocalRunGraph
} {
  return {
    id: draft.id,
    title: draft.title.trim() || draft.id,
    graph: localRunDraftGraph(draft)
  }
}

export function localRunDraftFromSaved(
  saved: LocalRunDraft,
  workspace: { selector: string; kind: 'folder' | 'git' }
): LocalRunCanvasDraft {
  return {
    id: saved.id,
    title: saved.title,
    workspacePath: saved.graph.workspacePath,
    workspaceSelector: workspace.selector,
    workspaceKind: workspace.kind,
    maxConcurrent: saved.graph.maxConcurrent ?? 3,
    nodes: saved.graph.nodes.map((node) =>
      newLocalRunDraftNode(node.id, {
        presetId: node.presetId,
        objective: node.objective,
        agent: node.actor.agent,
        model: node.actor.model ?? '',
        effort: node.actor.effort ?? '',
        accountChoiceId: node.actor.accountChoiceId ?? null,
        gate: Boolean(node.gate),
        gateQuestion: node.gate?.question ?? '',
        placement: node.placement === 'fleet' ? 'fleet' : 'local',
        deps: node.deps
      })
    )
  }
}

export function localRunDraftFromTemplate(
  templateId: LocalRunTemplateId,
  draft: LocalRunCanvasDraft,
  input: { objective: string; agent: TuiAgent; count?: number }
): LocalRunCanvasDraft {
  const graph = localRunTemplateGraph(templateId, {
    workspacePath: draft.workspacePath,
    actor: { agent: input.agent },
    objective: input.objective,
    ...(input.count === undefined ? {} : { count: input.count })
  })
  return {
    ...draft,
    maxConcurrent: graph.maxConcurrent ?? draft.maxConcurrent,
    nodes: graph.nodes.map((node) =>
      newLocalRunDraftNode(node.id, {
        presetId: node.presetId,
        objective: node.objective,
        agent: node.actor.agent,
        deps: node.deps
      })
    )
  }
}

/** Draft steps as the canvas graph, so authoring and watching are the same picture. */
export function localRunDraftView(draft: LocalRunCanvasDraft): LocalGraphView {
  return {
    id: draft.id,
    source: 'local-run',
    stage: 'created',
    workspacePath: draft.workspacePath,
    workspaceKind: draft.workspaceKind,
    coordinatorTerminalHandle: null,
    nodes: draft.nodes.map((node) => ({
      id: node.id,
      state: 'queued',
      actor: {
        agent: node.agent,
        ...(node.model ? { model: node.model } : {}),
        ...(node.effort ? { effort: node.effort } : {}),
        accountChoiceId: node.accountChoiceId
      },
      presetId: node.presetId,
      objective: node.objective,
      after: node.deps,
      placement: node.placement,
      workspacePath: draft.workspacePath,
      childWorkspaceName: null,
      producedFiles: [],
      manifestPath: null,
      reportPath: null,
      outputDir: null,
      terminalHandle: null,
      gateQuestion: node.gate ? node.gateQuestion : null,
      question: null,
      deliveryId: null,
      error: null,
      round: null
    })),
    loops: [],
    events: [],
    error: null,
    createdAt: '',
    updatedAt: ''
  }
}
