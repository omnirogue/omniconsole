import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { LOCAL_WORKFLOW_METHODS } from '../../../shared/local-workflow-rpc'
import type { WorkflowOpenRouterModel } from '../../../shared/workflow-openrouter-models'
import type {
  WorkflowModelPreset,
  WorkflowModelPresetInput
} from '../../../shared/workflow-model-presets'
import type { WorkflowModelTiers } from '../../../shared/workflow-model-tiers'

export type WorkflowModelTiersState = { tiers: WorkflowModelTiers; customized: boolean }

export const workflowModelClient = {
  models: () =>
    callRuntimeRpc<{ models: WorkflowOpenRouterModel[]; fetchedAt?: number }>(
      { kind: 'local' },
      LOCAL_WORKFLOW_METHODS.models,
      {}
    ),
  list: () =>
    callRuntimeRpc<{ presets: WorkflowModelPreset[] }>(
      { kind: 'local' },
      LOCAL_WORKFLOW_METHODS.listModelPresets,
      {}
    ),
  save: (input: WorkflowModelPresetInput) =>
    callRuntimeRpc<{ presets: WorkflowModelPreset[] }>(
      { kind: 'local' },
      LOCAL_WORKFLOW_METHODS.saveModelPreset,
      input
    ),
  tiers: () =>
    callRuntimeRpc<WorkflowModelTiersState>(
      { kind: 'local' },
      LOCAL_WORKFLOW_METHODS.modelTiers,
      {}
    ),
  /** `null` goes back to the built-in lineups. */
  saveTiers: (tiers: WorkflowModelTiers | null) =>
    callRuntimeRpc<WorkflowModelTiersState>(
      { kind: 'local' },
      LOCAL_WORKFLOW_METHODS.saveModelTiers,
      { tiers }
    ),
  delete: (id: string) =>
    callRuntimeRpc<{ presets: WorkflowModelPreset[] }>(
      { kind: 'local' },
      LOCAL_WORKFLOW_METHODS.deleteModelPreset,
      { id }
    )
}
