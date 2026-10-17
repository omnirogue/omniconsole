import { z } from 'zod'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  SESSION_OWNER_PAUSE_RPC,
  type SessionOwnerPauseParams,
  type SessionOwnerPauseResult
} from '../../../../shared/session-owner-pause'
import {
  pauseOwnedTerminal,
  PAUSE_SOURCE_CHANGED
} from '../../../session-manage/session-owner-pause'
import { runtimeControlDeps } from '../../../session-manage/session-manage-runtime-actions'
import { interruptSessionAgent } from '../../../session-manage/session-manage-runtime-interrupt'
import { getNextStepKeepGoingController } from '../../../next-steps/next-step-suggestion-slot'
import { assertSessionOutcomeUser } from '../../session-outcome-authority'
import { assertSessionOutcomeRuntime } from '../../session-outcome-host-boundary'
import { defineMethod } from '../core'
import { prepareSessionTarget } from './session-manage-support'
import { pauseOwnedStructured } from './session-owner-pause-structured'

const text = (max: number) => z.string().min(1).max(max)
const Params = z
  .object({
    expectedExecutionRuntimeId: text(512),
    target: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('terminal'),
          hostId: text(4096).refine((value) => {
            const host = parseExecutionHostId(value)
            return host?.kind === 'local' || host?.kind === 'ssh'
          }),
          worktreeId: text(4096),
          paneKey: text(1024),
          tabId: text(1024).optional(),
          agent: text(128),
          providerSessionId: text(1024),
          terminalHandle: text(1024),
          ptyId: text(1024),
          workingStartedAt: z.number().finite().nonnegative().optional(),
          prompt: z.string().max(100_000).optional()
        })
        .strict(),
      z
        .object({
          kind: z.literal('structured'),
          hostId: z.literal('local'),
          worktreeId: text(4096),
          sessionId: text(1024),
          turnId: text(1024).nullable(),
          runtimeFence: z.number().int().nonnegative()
        })
        .strict()
    ])
  })
  .strict()

export const SESSION_OWNER_PAUSE_METHOD = defineMethod({
  name: SESSION_OWNER_PAUSE_RPC,
  params: Params,
  handler: async (params: SessionOwnerPauseParams, context): Promise<SessionOwnerPauseResult> => {
    // This is a person's UI command; CLI and sessionHost caller gates remain unchanged.
    assertSessionOutcomeUser(context)
    assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
    const { runtime, signal } = context
    const expected = params.target
    try {
      if (expected.kind === 'structured') {
        return await pauseOwnedStructured(context, params.expectedExecutionRuntimeId, expected)
      }
      const keepGoing = getNextStepKeepGoingController()
      if (!keepGoing) {
        throw new Error('Keep going state is unavailable on the execution host.')
      }
      const target = await prepareSessionTarget(runtime, expected)
      const { row, entry, agentProcess } = target
      const incarnation = runtime.getTerminalProcessIncarnation(expected.terminalHandle)
      const initialHook = runtime.getFreshAgentHookStatusForHandle(expected.terminalHandle)
      const initialTurn = initialHook && [
        initialHook.state,
        initialHook.stateStartedAt,
        initialHook.prompt
      ]
      const sameConversation = (): boolean => {
        try {
          assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
          const pane = runtime.resolveTerminalPane(expected.paneKey, expected.worktreeId)
          return (
            !signal?.aborted &&
            getNextStepKeepGoingController() === keepGoing &&
            Boolean(incarnation) &&
            row.kind === 'terminal' &&
            row.worktreeId === expected.worktreeId &&
            row.hostId === expected.hostId &&
            row.agent === expected.agent &&
            row.providerSessionId === expected.providerSessionId &&
            row.paneKey === expected.paneKey &&
            (!expected.tabId || row.tabId === expected.tabId) &&
            entry.terminal === expected.terminalHandle &&
            pane.handle === expected.terminalHandle &&
            pane.ptyId === expected.ptyId &&
            pane.worktreeId === expected.worktreeId &&
            pane.executionHostId === expected.hostId &&
            pane.connected === true &&
            runtime.getTerminalProcessIncarnation(expected.terminalHandle) === incarnation &&
            runtime.getReportedProviderSessionsForPane(expected.paneKey)[0]?.id ===
              expected.providerSessionId
          )
        } catch {
          return false
        }
      }
      const stillCurrent = (): boolean => {
        const hook = runtime.getFreshAgentHookStatusForHandle(expected.terminalHandle)
        const turn = hook && [hook.state, hook.stateStartedAt, hook.prompt]
        return (
          sameConversation() &&
          JSON.stringify(turn) === JSON.stringify(initialTurn) &&
          (entry.state !== 'working' ||
            Boolean(
              agentProcess &&
              hook?.state === 'working' &&
              hook.stateStartedAt === expected.workingStartedAt &&
              (expected.prompt === undefined || hook.prompt === expected.prompt)
            ))
        )
      }
      if (!stillCurrent()) {
        return { state: 'source-changed', message: PAUSE_SOURCE_CHANGED }
      }
      const controls = runtimeControlDeps(runtime)
      return await pauseOwnedTerminal(
        {
          ...controls,
          interrupt: (handle, receiver, source) =>
            interruptSessionAgent(runtime, handle, receiver, source, stillCurrent)
        },
        target,
        stillCurrent,
        sameConversation
      )
    } catch (error) {
      return {
        state: 'unverifiable',
        message:
          error instanceof Error ? error.message : 'The execution host could not verify the pause.'
      }
    }
  }
})
