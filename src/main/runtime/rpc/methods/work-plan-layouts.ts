import { z } from 'zod'
import {
  WORK_PLAN_LAYOUTS_RPC,
  WorkPlanLayoutStageSchema
} from '../../../../shared/work-plan-layouts'
import { assertSessionOutcomeUser } from '../../session-outcome-authority'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const Name = requiredString('Missing workflow name')
const Id = requiredString('Missing workflow id').pipe(z.string().max(200))

export const WORK_PLAN_LAYOUTS_METHODS: RpcMethod[] = [
  defineMethod({
    name: WORK_PLAN_LAYOUTS_RPC.list,
    params: z.object({}).strict(),
    handler: (_params, context) => {
      if (context.orchestrationCapability || context.orchestrationCompatibilityEvidence) {
        throw new Error(
          'This decision requires the authenticated user interface, not an agent assertion.'
        )
      }
      return { layouts: context.runtime.listWorkPlanLayouts() }
    }
  }),
  defineMethod({
    name: WORK_PLAN_LAYOUTS_RPC.save,
    params: z.object({ name: Name, stage: WorkPlanLayoutStageSchema }).strict(),
    handler: (params, context) => {
      assertSessionOutcomeUser(context)
      return { layouts: context.runtime.saveWorkPlanLayout(params) }
    }
  }),
  defineMethod({
    name: WORK_PLAN_LAYOUTS_RPC.rename,
    params: z.object({ id: Id, name: Name }).strict(),
    handler: (params, context) => {
      assertSessionOutcomeUser(context)
      return { layouts: context.runtime.renameWorkPlanLayout(params.id, params.name) }
    }
  }),
  defineMethod({
    name: WORK_PLAN_LAYOUTS_RPC.delete,
    params: z.object({ id: Id }).strict(),
    handler: (params, context) => {
      assertSessionOutcomeUser(context)
      return { layouts: context.runtime.deleteWorkPlanLayout(params.id) }
    }
  })
]
