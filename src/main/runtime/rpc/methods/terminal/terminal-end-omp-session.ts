import { z } from 'zod'
import { recognizeAgentProcess } from '../../../../../shared/agent-process-recognition'
import { assertSessionOutcomeUser } from '../../../session-outcome-authority'
import {
  assertSessionOutcomeRuntime,
  sessionOutcomeLocalWorkspace
} from '../../../session-outcome-host-boundary'
import type { OrcaRuntimeService } from '../../../omni-runtime'
import { defineMethod, type RpcAnyMethod } from '../../core'

const ExactOmpSession = z
  .object({
    paneKey: z.string().min(1).max(1024),
    worktreeId: z.string().min(1).max(4096),
    expectedPtyId: z.string().min(1).max(1024),
    expectedProviderSessionId: z.string().min(1).max(512),
    expectedExecutionRuntimeId: z.string().min(1).max(512)
  })
  .strict()

type ExitRequest = { requested: true }
// A lost acknowledgement must not replay EOF into the shell that OMP leaves behind.
const requests = new WeakMap<OrcaRuntimeService, Map<string, Promise<ExitRequest>>>()

export const END_OMP_SESSION_METHOD = defineMethod({
  name: 'terminal.endOmpSession',
  params: ExactOmpSession,
  handler: async (params, context): Promise<ExitRequest> => {
    assertSessionOutcomeUser(context)
    assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
    const { runtime, signal } = context
    await sessionOutcomeLocalWorkspace(runtime, params.worktreeId)
    const terminal = runtime.resolveTerminalPane(params.paneKey, params.worktreeId)
    const incarnation = runtime.getTerminalProcessIncarnation(terminal.handle)
    const assertCurrent = (ptyId = params.expectedPtyId) => {
      if (signal?.aborted) {
        throw new Error('End session was cancelled before delivery.')
      }
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      const current = runtime.resolveTerminalPane(params.paneKey, params.worktreeId)
      const source = runtime.getSessionOutcomeTranscriptSource({
        sourcePaneKey: params.paneKey,
        worktreeId: params.worktreeId
      })
      if (
        !incarnation ||
        current.handle !== terminal.handle ||
        current.ptyId !== params.expectedPtyId ||
        ptyId !== params.expectedPtyId ||
        current.worktreeId !== params.worktreeId ||
        current.connected === false ||
        runtime.getTerminalProcessIncarnation(terminal.handle) !== incarnation ||
        source?.kind !== 'provider' ||
        source.hostId !== 'local' ||
        source.agent !== 'omp' ||
        source.sessionId !== params.expectedProviderSessionId
      ) {
        throw new Error(
          'The OMP session owner changed. Inspect the selected conversation before ending it.'
        )
      }
      if (runtime.getOrchestrationDb().getActiveDispatchForTerminal(terminal.handle)) {
        throw new Error('End this worker from its task so it is not relaunched.')
      }
    }
    assertCurrent()
    let owned = requests.get(runtime)
    if (!owned) {
      owned = new Map()
      requests.set(runtime, owned)
    }
    const key = JSON.stringify([terminal.handle, incarnation, params.expectedProviderSessionId])
    const previous = owned.get(key)
    if (previous) {
      return previous
    }
    let writeAttempted = false
    const request = (async (): Promise<ExitRequest> => {
      const assertForeground = async (ptyId: string) => {
        assertCurrent(ptyId)
        const process = await runtime.inspectTerminalProcess(terminal.handle)
        assertCurrent(ptyId)
        if (
          process.unavailable ||
          recognizeAgentProcess(process.foregroundProcess)?.agent !== 'omp'
        ) {
          throw new Error(
            'OMP is not confirmed in the foreground. Inspect Terminal before ending the session.'
          )
        }
      }
      await assertForeground(params.expectedPtyId)
      runtime.cancelSessionInput(params.expectedPtyId)
      // OMP app.exit preserves its editor draft and disposes its owned background jobs.
      const receipt = await runtime.sendTerminal(
        terminal.handle,
        { text: '\x04' },
        {
          signal,
          beforeWrite: assertForeground,
          reserveWrite: (ptyId) => {
            assertCurrent(ptyId)
            writeAttempted = true
          }
        }
      )
      if (!receipt.accepted) {
        throw new Error('End session delivery is unconfirmed. Inspect Terminal before continuing.')
      }
      return { requested: true }
    })()
    owned.set(key, request)
    try {
      return await request
    } catch (error) {
      if (!writeAttempted) {
        owned.delete(key)
      }
      throw error
    }
  }
})

export const TERMINAL_END_OMP_SESSION_METHODS: RpcAnyMethod[] = [END_OMP_SESSION_METHOD]
