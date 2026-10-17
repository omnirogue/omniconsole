import { useCallback, useState } from 'react'
import {
  useBriefWorkspace,
  type BriefWorkspace
} from '../attention/assisted-brief/assisted-brief-workspace'
import { useBriefGeneration } from '../attention/assisted-brief/use-brief-generation'
import type { WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import {
  compileWorkflowDescription,
  type WorkflowCompileModels,
  type WorkflowCompileResult
} from '../../../../shared/workflow-graph-compile'
import {
  compileWorkflowModelPlan,
  type WorkflowModelPlanContext,
  type WorkflowModelPlanResult
} from '../../../../shared/workflow-model-plan'
import { translate } from '@/i18n/i18n'
import { localWorkflowProviderLabel } from '../../../../shared/local-workflow-model-label'

const COMPILER = { agent: 'claude' as const, label: localWorkflowProviderLabel('claude') }

/**
 * Natural language → workflow: the assisted-brief one-shot agent (read-only, the workspace's own
 * account) answers, and the shared compiler reads, normalizes, validates and repairs once. The
 * same agent answers a model plan: which models run which steps, and nothing else.
 */
function useCompileWith(workspace: BriefWorkspace) {
  const generation = useBriefGeneration(workspace)
  const [compiling, setCompiling] = useState(false)
  const asking = useCallback(
    async <Result extends object>(
      run: (ask: (prompt: string) => Promise<string>) => Promise<Result | { error: string }>
    ): Promise<Result | { error: string }> => {
      setCompiling(true)
      try {
        let failure = ''
        const result = await run(async (prompt) => {
          const text = await generation.run({ purpose: 'draft', actor: COMPILER }, prompt)
          if (text === null) {
            failure =
              generation.error ||
              translate('workflowGraph.compile.noAnswer', 'Claude did not answer.')
            return ''
          }
          return text
        })
        return failure && 'error' in result ? { error: failure } : result
      } finally {
        setCompiling(false)
      }
    },
    [generation]
  )
  const compile = useCallback(
    (input: {
      description: string
      current?: WorkflowSpec
      available: readonly WorkflowRoute[]
      models?: WorkflowCompileModels
    }): Promise<WorkflowCompileResult | { error: string }> =>
      asking((ask) => compileWorkflowDescription({ ...input, ask })),
    [asking]
  )
  const planModels = useCallback(
    (input: {
      description: string
      spec: WorkflowSpec
      context: WorkflowModelPlanContext
    }): Promise<WorkflowModelPlanResult | { error: string }> =>
      asking((ask) => compileWorkflowModelPlan({ ...input, ask })),
    [asking]
  )
  return { compile, planModels, compiling, cancel: generation.cancel }
}

export function useWorkflowCompile(worktreeId: string) {
  const workspace = useBriefWorkspace(worktreeId)
  return useCompileWith(
    workspace ?? {
      worktreeId,
      workspaceKey: worktreeId,
      label: '',
      kind: 'folder',
      worktreePath: null,
      paired: false
    }
  )
}
