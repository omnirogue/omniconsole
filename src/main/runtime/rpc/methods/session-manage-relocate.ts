// `sessionManage.relocate`: `omni session relocate` on this computer's CLI (Phase 4 E2). The target
// is read and the caller identified exactly as for handoff; the move itself runs in
// session-transfer-relocate-command.ts.

import { z } from 'zod'
import { isSessionHostOperationId } from '../../../../shared/session-host-identity'
import { SESSION_RELOCATE_RPC } from '../../../../shared/session-relocation-types'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { relocateFromCommand } from '../../../session-manage/session-transfer-relocate-command'
import { defineMethod, type RpcMethod } from '../core'
import { SessionManageTarget } from './session-manage-schemas'
import { prepareSessionAction } from './session-manage-support'

const text = (max: number) => z.string().trim().min(1).max(max)

const SessionManageRelocateParams = z
  .object({
    target: SessionManageTarget,
    to: text(4096),
    workspace: text(4096),
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'A commit is its full 40-character id.')
      .optional(),
    relocation: z
      .string()
      .refine(isSessionHostOperationId, 'Continue a move with the id it reported.')
      .optional(),
    reason: text(1000).optional(),
    request: text(4000).optional(),
    dryRun: z.boolean().optional()
  })
  .strict()

export const SESSION_MANAGE_RELOCATE_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_RELOCATE_RPC,
    params: SessionManageRelocateParams,
    handler: async (params, context) => {
      const { target, ...options } = params
      return await relocateFromCommand({
        runtime: context.runtime,
        userDataPath: getProfileUserDataPath(),
        prepared: await prepareSessionAction(context, target),
        params: options,
        ...(context.signal ? { signal: context.signal } : {})
      })
    }
  })
]
