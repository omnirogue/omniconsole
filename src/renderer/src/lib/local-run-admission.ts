import { translate } from '@/i18n/i18n'
import { newWorkflowAdmissionDraft } from './console-workflow-admission-draft'
import { newWorkflowStage, type WorkflowDraft } from './console-workflow-draft'
import { localRunDraftGraph, type LocalRunCanvasDraft } from './local-run-draft'
import { normalizeLocalRunGraph } from '../../../shared/local-run-graph'
import { localRunNodesInLevelOrder } from '../../../shared/local-run-node-state'

/**
 * What a canvas draft may do, and why it may not. Every refusal names the reason and
 * the steps involved: a person who cannot run their graph must be told what to change,
 * not left with a disabled button.
 */
export type LocalRunDraftRefusal = {
  code: 'no-steps' | 'no-objective' | 'no-gate-question' | 'fleet-placed' | 'invalid-graph'
  message: string
}

export function localRunStartRefusal(draft: LocalRunCanvasDraft): LocalRunDraftRefusal | null {
  if (draft.nodes.length === 0) {
    return {
      code: 'no-steps',
      message: translate('localRun.refusal.noSteps', 'Add at least one step before running.')
    }
  }
  const missingObjective = draft.nodes.filter((node) => !node.objective.trim())
  if (missingObjective.length > 0) {
    return {
      code: 'no-objective',
      message: `${translate(
        'localRun.refusal.noObjective',
        'Every step needs an objective. Missing on'
      )}: ${missingObjective.map((node) => node.id).join(', ')}.`
    }
  }
  const missingGate = draft.nodes.filter((node) => node.gate && !node.gateQuestion.trim())
  if (missingGate.length > 0) {
    return {
      code: 'no-gate-question',
      message: `${translate(
        'localRun.refusal.noGateQuestion',
        'A step that asks first needs the question it asks. Missing on'
      )}: ${missingGate.map((node) => node.id).join(', ')}.`
    }
  }
  const fleet = draft.nodes.filter((node) => node.placement === 'fleet')
  if (fleet.length > 0) {
    return {
      code: 'fleet-placed',
      message: `${translate(
        'localRun.refusal.fleetPlaced',
        'Fleet steps are admitted through the console, never started here. Placed on the fleet'
      )}: ${fleet.map((node) => node.id).join(', ')}.`
    }
  }
  if (!normalizeLocalRunGraph(localRunDraftGraph(draft))) {
    return {
      code: 'invalid-graph',
      message: translate(
        'localRun.refusal.invalidGraph',
        'This graph is not a finite set of steps whose dependencies all exist.'
      )
    }
  }
  return null
}

export type LocalRunAdmissionRefusal = {
  code: 'folder-workspace' | 'not-sequential' | 'draft-not-runnable'
  message: string
}

/**
 * Admitting work through the console is git-only, and this client admits sequential
 * stages only until Lane 2 confirms parallel columns. A folder workspace is refused by
 * naming the folder — it is not a lesser workspace, it is simply run locally instead.
 */
export function localRunAdmissionRefusal(
  draft: LocalRunCanvasDraft
): LocalRunAdmissionRefusal | null {
  if (draft.workspaceKind !== 'git') {
    return {
      code: 'folder-workspace',
      message: `${translate(
        'localRun.refusal.folderWorkspace',
        'Admitting work through the console needs a git workspace. Run this graph locally instead of admitting it. This workspace is a folder'
      )}: ${draft.workspacePath}.`
    }
  }
  const blocked = localRunStartRefusal(draft)
  if (blocked && blocked.code !== 'fleet-placed') {
    return { code: 'draft-not-runnable', message: blocked.message }
  }
  if (!isSequentialLocalRunDraft(draft)) {
    return {
      code: 'not-sequential',
      message: translate(
        'localRun.refusal.notSequential',
        'This release admits sequential stages only. Chain the steps one after another, or run the graph locally.'
      )
    }
  }
  return null
}

/** One chain: each step depends on exactly the step before it. */
export function isSequentialLocalRunDraft(draft: LocalRunCanvasDraft): boolean {
  const graph = normalizeLocalRunGraph(localRunDraftGraph(draft))
  if (!graph) {
    return false
  }
  const ordered = localRunNodesInLevelOrder(graph)
  return ordered.every((node, index) =>
    index === 0
      ? node.deps.length === 0
      : node.deps.length === 1 && node.deps[0] === ordered[index - 1].id
  )
}

/**
 * The canvas draft as Lane 3's transient composer draft. Nothing is admitted here: the
 * person completes the card, organization and policies in the composer, previews the
 * exact server graph and approves it there. Placement travels per stage, which is
 * where fleet work belongs.
 */
export function localRunAdmissionDraft(draft: LocalRunCanvasDraft): WorkflowDraft {
  const graph = normalizeLocalRunGraph(localRunDraftGraph(draft))
  const nodes = graph ? localRunNodesInLevelOrder(graph) : []
  return {
    taskId: '',
    title: draft.title.trim() || draft.id,
    company: '',
    repo: '',
    prompt: nodes[0]?.objective ?? '',
    placement: draft.nodes.some((node) => node.placement === 'fleet') ? 'fleet' : 'local',
    stages: nodes.map((node, index) => ({
      ...newWorkflowStage(node.id, index === 0 ? [] : [nodes[index - 1].id]),
      title: node.id,
      actorType: 'ai',
      provider: node.actor.agent,
      model: node.actor.model ?? '',
      effort: node.actor.effort ?? '',
      prompt: node.objective,
      placement:
        draft.nodes.find((entry) => entry.id === node.id)?.placement === 'fleet' ? 'fleet' : 'local'
    })),
    admission: { ...newWorkflowAdmissionDraft(), adoptStage: nodes[0]?.id ?? '' }
  }
}
