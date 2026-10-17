import { z } from 'zod'
import {
  JEV_RUBRIC_METHODS,
  jevRubricEvaluationSchema,
  jevRubricSaveSchema,
  resolveJevRubric
} from '../../../../shared/jev-rubrics'
import { getStructuredDecisionRuntime } from '../../../structured-decisions/decision-runtime'
import { defineMethod, type RpcMethod } from '../core'

export const JEV_RUBRIC_RPC_METHODS: RpcMethod[] = [
  defineMethod({
    name: JEV_RUBRIC_METHODS.list,
    params: z.object({}).strict().default({}),
    handler: (_params, { runtime }) => ({ rubrics: runtime.getJevRubricLibrary() })
  }),
  defineMethod({
    name: JEV_RUBRIC_METHODS.save,
    params: jevRubricSaveSchema,
    handler: ({ rubric, replace }, { runtime }) => ({
      rubric: runtime.saveJevRubric(rubric, replace)
    })
  }),
  defineMethod({
    name: JEV_RUBRIC_METHODS.evaluate,
    params: jevRubricEvaluationSchema,
    handler: async ({ input, control }, { runtime }) => {
      const entry = resolveJevRubric(runtime.getJevRubricLibrary(), input.rubric)
      const decisions = getStructuredDecisionRuntime(runtime)
      const host = await decisions.jev.status()
      return decisions.evaluateRubric(input, entry, {
        disabled: control === 'off' || host.effective === 'off',
        control
      })
    }
  })
]
