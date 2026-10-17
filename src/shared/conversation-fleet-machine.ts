import type {
  ConsoleConversationFleetInventory,
  ConsoleConversationFleetMachine
} from './console-conversation-fleet-types'
import {
  buildConversationFleetWorkflow,
  type ConversationFleetWorkflowInput
} from './conversation-fleet-workflow'
import type { NextStepDraft } from './next-step-draft'
import type { ConversationFleetHandoffInputs } from './conversation-fleet-handoff'
import { conversationFleetCapabilityModels } from './conversation-fleet-capability-usage'

export type ConversationFleetMachineOptions = ConversationFleetHandoffInputs & {
  sourceWorkspacePath?: string
  settings?: ConversationFleetWorkflowInput['settings']
  selectedMachine?: string | null
  now?: number
}

type Route = {
  provider: string
  model: string
  effort?: string
  retainedOutputs: boolean
}

export function hasConversationFleetAgent(draft: NextStepDraft): boolean {
  return (
    draft.recipients.some((recipient) => recipient.kind === 'agent') ||
    draft.after.some((step) => step.kind === 'agent')
  )
}

function selectedRoutes(
  draft: NextStepDraft,
  inventory: ConsoleConversationFleetInventory,
  options: ConversationFleetMachineOptions
): Route[] {
  if (!hasConversationFleetAgent(draft)) {
    throw new Error('A people-only delivery uses Add Next and does not need a fleet machine.')
  }
  if (inventory.models_fallback) {
    throw new Error('Fleet model availability is unverified. Refresh the fleet inventory.')
  }
  const workflow = buildConversationFleetWorkflow({
    operationId: 'route_selection',
    companySlug: 'route-selection',
    draft,
    ...(options.selectedMachine ? { machine: options.selectedMachine } : {}),
    sourceSummaryFile: options.sourceSummaryFile,
    sourceDeliverableFiles: options.sourceDeliverableFiles,
    sourceDeliverablePaths: options.sourceDeliverablePaths,
    sourceDeliverables: options.sourceDeliverables,
    settings: options.settings,
    context: {
      title: 'Select an execution host',
      sourceSessionId: 'route-selection',
      sourceWorkspacePath: options.sourceWorkspacePath ?? '',
      transcript: 'Capability selection only.'
    }
  })
  return workflow.classification.steps
    .filter((step) => step.actor_type === 'ai')
    .map((step) => {
      const actor = step.actor_id!
      const row = inventory.models.find(
        (model) => model.id === actor || (model.provider === actor && model.default)
      )
      if (!row) {
        throw new Error(`${actor} is not advertised by the fleet. Choose an available model.`)
      }
      const effort = step.effort === 'default' ? undefined : (step.effort ?? undefined)
      if (effort && !row.supported_efforts.includes(effort)) {
        throw new Error(`${row.id} does not support the selected ${effort} effort.`)
      }
      return {
        provider: row.provider,
        model: row.model,
        effort,
        retainedOutputs: Boolean(step.handoff_report || step.output_artifacts)
      }
    })
}

function supportsFolder(
  machine: ConsoleConversationFleetMachine,
  routes: Route[],
  now: number
): boolean {
  return (
    machine.allowed &&
    routes.every((route) =>
      machine.execution_capabilities.some(
        (capability) =>
          capability.provider === route.provider &&
          capability.folder_workspace === true &&
          (!route.retainedOutputs || capability.retained_outputs === true) &&
          (!route.effort || capability.efforts.includes(route.effort)) &&
          conversationFleetCapabilityModels(
            capability,
            [{ id: route.model, label: route.model, options: [] }],
            now
          ).length > 0
      )
    )
  )
}

/** A folder stays on one host so every stage sees the same allocated workspace. */
export function resolveConversationFleetFolderMachine(
  draft: NextStepDraft,
  inventory: ConsoleConversationFleetInventory,
  options: ConversationFleetMachineOptions = {}
): string {
  const routes = selectedRoutes(draft, inventory, options)
  const now = options.now ?? Date.now()
  const requirements = routes.some((route) => route.retainedOutputs)
    ? 'captured source files and retained deliverables'
    : 'captured source files'
  if (options.selectedMachine) {
    const selected = inventory.machines.find((machine) => machine.host === options.selectedMachine)
    if (selected && supportsFolder(selected, routes, now)) {
      return selected.host
    }
    throw new Error(
      `${options.selectedMachine} cannot run every selected folder workflow stage with ${requirements}.`
    )
  }
  const selected = inventory.machines
    .filter((machine) => machine.ready && supportsFolder(machine, routes, now))
    .sort((left, right) => (left.host < right.host ? -1 : left.host > right.host ? 1 : 0))[0]
  if (!selected) {
    throw new Error(
      `No ready fleet machine can run every selected folder workflow stage with ${requirements}.`
    )
  }
  return selected.host
}
