import { z } from 'zod'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { normalizeSessionFollowUpRule } from '../../../../shared/session-follow-up-rule'
import { captureSshSessionHandoff } from '../../session-handoff-capture'
import { assertSessionOutcomeUser } from '../../session-outcome-authority'
import { defineMethod } from '../core'

/** Immediate sharing owns no continuation; its explicit SSH owner is checked at every IO boundary. */
export const SESSION_HANDOFF_NOW_METHOD = defineMethod({
  name: 'sessionChain.captureHandoffNow',
  params: z
    .object({
      paneKey: z.string().min(1),
      worktreeId: z.string().min(1),
      expectedConnectionId: z.string().min(1),
      handoff: z.unknown(),
      summary: z.string().min(1).max(20_000)
    })
    .strict(),
  handler: async (params, context) => {
    assertSessionOutcomeUser(context)
    const expectedHost = toSshExecutionHostId(params.expectedConnectionId)
    const first = context.runtime.resolveTerminalPane(params.paneKey, params.worktreeId)
    const assertOwner = (): void => {
      const current = context.runtime.resolveTerminalPane(params.paneKey, params.worktreeId)
      if (
        current.worktreeId !== params.worktreeId ||
        current.executionHostId !== expectedHost ||
        current.handle !== first.handle ||
        current.ptyId !== first.ptyId
      ) {
        throw new Error('The session execution host changed. Reopen its handoff before retrying.')
      }
      context.signal?.throwIfAborted()
    }
    assertOwner()
    const workspace = await context.runtime.showManagedTerminalWorkspace(`id:${params.worktreeId}`)
    assertOwner()
    if (workspace.hostId !== expectedHost) {
      throw new Error('The selected workspace does not belong to this SSH session.')
    }
    const rule = normalizeSessionFollowUpRule(params.handoff)
    if (!rule) {
      throw new Error('The handoff is incomplete.')
    }
    return {
      handoff: await captureSshSessionHandoff(
        rule,
        workspace.path,
        params.summary,
        params.expectedConnectionId,
        assertOwner
      )
    }
  }
})
