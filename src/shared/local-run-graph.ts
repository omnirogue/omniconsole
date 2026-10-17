import { isSessionActionPresetId, type SessionActionPresetId } from './session-action-presets'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

/**
 * A local Run graph: unadmitted personal work the IDE executes itself. It is not a
 * hub concept — no card, no queue, no claim — and it never completes anyone's card.
 * The workspace is a folder; git is optional. Artifacts are files of any type,
 * handed on by path under `<workspace>/.omni/runs/<runId>/`.
 */
export type LocalRunActor = {
  agent: TuiAgent
  model?: string
  effort?: string
  /** `managed:<id>` / `profile:<id>`; the config directory the CLI starts under. */
  accountChoiceId?: string | null
}

/** Ask a person before this node runs. Execution scope only: business decisions need a card. */
export type LocalRunGate = { question: string; options?: string[] }

/**
 * Where a node is meant to run. `local` is this desktop's own runner; `fleet` is work
 * a person intends to admit through the console, which the local runner refuses to
 * start (SYSTEMS.md 2026-09-09: fleet placement stays on the console seam).
 */
export type LocalRunNodePlacement = 'local' | 'fleet'

/** Hand this node's produced files to a person or a card through the console board routes. */
export type LocalRunDeliver = { taskId: string; to: string[]; message?: string }

export type LocalRunNode = {
  id: string
  actor: LocalRunActor
  presetId: SessionActionPresetId
  objective: string
  gate?: LocalRunGate
  deliver?: LocalRunDeliver
  /** Absent means `local`; a saved graph only records an explicit fleet intent. */
  placement?: LocalRunNodePlacement
  deps: string[]
}

export type LocalRunGraph = {
  nodes: LocalRunNode[]
  /** Absolute path of the workspace folder. Git optional. */
  workspacePath: string
  maxConcurrent?: number
}

/** A saved graph definition, kept beside automations so a canvas can load it later. */
export type LocalRunDraft = {
  id: string
  title: string
  graph: LocalRunGraph
  createdAt: number
  updatedAt: number
}

export const LOCAL_RUN_MAX_NODES = 64
export const LOCAL_RUN_MAX_CONCURRENT = 8
export const LOCAL_RUN_NODE_ID = /^[A-Za-z0-9_-]{1,64}$/

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeActor(value: unknown): LocalRunActor | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  if (!isTuiAgent(record.agent)) {
    return null
  }
  return {
    agent: record.agent,
    ...(text(record.model) ? { model: text(record.model) } : {}),
    ...(text(record.effort) ? { effort: text(record.effort) } : {}),
    ...(text(record.accountChoiceId) ? { accountChoiceId: text(record.accountChoiceId) } : {})
  }
}

function normalizeGate(value: unknown): LocalRunGate | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  const question = text(record.question)
  if (!question) {
    return undefined
  }
  const options = Array.isArray(record.options)
    ? record.options.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim())
    : []
  return { question, ...(options.length > 0 ? { options } : {}) }
}

function normalizeDeliver(value: unknown): LocalRunDeliver | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  const taskId = text(record.taskId)
  const to = Array.isArray(record.to)
    ? record.to.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim())
    : []
  if (!taskId || to.length === 0) {
    return undefined
  }
  return { taskId, to, ...(text(record.message) ? { message: text(record.message) } : {}) }
}

export function normalizeLocalRunNode(value: unknown): LocalRunNode | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  const id = text(record.id)
  const objective = text(record.objective)
  const actor = normalizeActor(record.actor)
  if (!id || !LOCAL_RUN_NODE_ID.test(id) || !objective || !actor) {
    return null
  }
  if (!isSessionActionPresetId(record.presetId)) {
    return null
  }
  const deps = Array.isArray(record.deps)
    ? [...new Set(record.deps.filter((entry): entry is string => typeof entry === 'string'))]
    : []
  const gate = normalizeGate(record.gate)
  const deliver = normalizeDeliver(record.deliver)
  return {
    id,
    actor,
    presetId: record.presetId,
    objective,
    ...(gate ? { gate } : {}),
    ...(deliver ? { deliver } : {}),
    ...(record.placement === 'fleet' ? { placement: 'fleet' as const } : {}),
    deps
  }
}

export function localRunNodePlacement(node: LocalRunNode): LocalRunNodePlacement {
  return node.placement === 'fleet' ? 'fleet' : 'local'
}

/**
 * Nodes a person placed on the fleet. They are a drafting intent, not something this
 * desktop may start: the console admits them. Naming them lets a refusal say which.
 */
export function localRunFleetNodeIds(graph: LocalRunGraph): string[] {
  return graph.nodes.filter((node) => localRunNodePlacement(node) === 'fleet').map((n) => n.id)
}

/**
 * A graph is admissible only when it is a finite DAG over known nodes. A cycle or a
 * missing dependency would leave tasks blocked forever, which the runner would then
 * report as a stuck DAG rather than as the authoring mistake it is.
 */
export function normalizeLocalRunGraph(value: unknown): LocalRunGraph | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  const workspacePath = text(record.workspacePath)
  const nodes = Array.isArray(record.nodes)
    ? record.nodes.map(normalizeLocalRunNode).filter((node): node is LocalRunNode => !!node)
    : []
  if (!workspacePath || nodes.length === 0 || nodes.length > LOCAL_RUN_MAX_NODES) {
    return null
  }
  const ids = new Set(nodes.map((node) => node.id))
  if (ids.size !== nodes.length) {
    return null
  }
  if (nodes.some((node) => node.deps.some((dep) => !ids.has(dep) || dep === node.id))) {
    return null
  }
  if (hasCycle(nodes)) {
    return null
  }
  const maxConcurrent =
    typeof record.maxConcurrent === 'number' && Number.isInteger(record.maxConcurrent)
      ? Math.min(Math.max(record.maxConcurrent, 1), LOCAL_RUN_MAX_CONCURRENT)
      : undefined
  return {
    nodes,
    workspacePath,
    ...(maxConcurrent === undefined ? {} : { maxConcurrent })
  }
}

function hasCycle(nodes: LocalRunNode[]): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const state = new Map<string, 'open' | 'closed'>()
  const visit = (id: string): boolean => {
    const mark = state.get(id)
    if (mark === 'open') {
      return true
    }
    if (mark === 'closed') {
      return false
    }
    state.set(id, 'open')
    for (const dep of byId.get(id)?.deps ?? []) {
      if (visit(dep)) {
        return true
      }
    }
    state.set(id, 'closed')
    return false
  }
  return nodes.some((node) => visit(node.id))
}

export function normalizeLocalRunDraft(value: unknown): LocalRunDraft | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  const id = text(record.id)
  const graph = normalizeLocalRunGraph(record.graph)
  if (!id || !graph) {
    return null
  }
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0
  return {
    id,
    title: text(record.title) ?? id,
    graph,
    createdAt,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : createdAt
  }
}

export function normalizeLocalRunDrafts(value: unknown): LocalRunDraft[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const drafts: LocalRunDraft[] = []
  for (const entry of value) {
    const draft = normalizeLocalRunDraft(entry)
    if (draft && !seen.has(draft.id)) {
      seen.add(draft.id)
      drafts.push(draft)
    }
  }
  return drafts
}
