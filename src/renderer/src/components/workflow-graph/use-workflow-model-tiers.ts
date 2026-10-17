import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { workflowModelClient, type WorkflowModelTiersState } from '@/lib/workflow-model-client'
import type { WorkflowCompileModels } from '../../../../shared/workflow-graph-compile'
import {
  DEFAULT_WORKFLOW_MODEL_TIERS,
  type WorkflowModelDefaults,
  type WorkflowModelTiers
} from '../../../../shared/workflow-model-tiers'
import { workflowModelDefaults, type WorkflowModelSource } from './workflow-model-sources'

export type WorkflowModelTierState = {
  tiers: WorkflowModelTiers
  customized: boolean
  /** A change could not be saved; it still applies until the window closes. */
  saveError: boolean
  save: (tiers: WorkflowModelTiers | null) => Promise<void>
}

// One copy for the window: every open workflow sees a tier change at once, and none saves over
// another's with lineups it loaded earlier.
let shared: WorkflowModelTiersState = { tiers: DEFAULT_WORKFLOW_MODEL_TIERS, customized: false }
const listeners = new Set<() => void>()
function publish(next: WorkflowModelTiersState): void {
  shared = next
  listeners.forEach((listener) => listener())
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The person's Cheap / Standard / Frontier lineups. Until the host answers (or when it cannot:
 * an older host has no tier methods) the built-in lineups apply, so the picker always works.
 */
export function useWorkflowModelTiers(): WorkflowModelTierState {
  const state = useSyncExternalStore(subscribe, () => shared)
  const [saveError, setSaveError] = useState(false)
  useEffect(() => {
    void (async () => {
      try {
        publish(await workflowModelClient.tiers())
      } catch {
        // The lineups already in use stay.
      }
    })()
  }, [])
  const save = useCallback(async (tiers: WorkflowModelTiers | null) => {
    publish({ tiers: tiers ?? DEFAULT_WORKFLOW_MODEL_TIERS, customized: !!tiers })
    try {
      publish(await workflowModelClient.saveTiers(tiers))
      setSaveError(false)
    } catch {
      setSaveError(true)
    }
  }, [])
  return { ...state, saveError, save }
}

/** What the setup screen needs to choose models: the lineups, each family's default, and both for a compile. */
export function useWorkflowSetupModels(sources: readonly WorkflowModelSource[] | undefined): {
  tierState: WorkflowModelTierState
  modelDefaults: WorkflowModelDefaults
  /** A described "cheap" or "frontier" becomes this person's lineups, not the built-in ones. */
  compileModels: WorkflowCompileModels
} {
  const tierState = useWorkflowModelTiers()
  const modelDefaults = useMemo(() => workflowModelDefaults(sources ?? []), [sources])
  return {
    tierState,
    modelDefaults,
    compileModels: { tiers: tierState.tiers, defaults: modelDefaults }
  }
}
