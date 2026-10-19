import { z } from 'zod'
import { attachContractVerify } from '../../session-contract-verify'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { noteAgentSession } from '../../../session-organization/agent-session-mark'

const PANE_KEY_WAIT_MS = 10_000
const PANE_KEY_POLL_MS = 250

/** A terminal created a moment ago may not have its stable pane identity yet. */
async function launchedPaneKey(
  runtime: { getTerminalPaneKey(handle: string): string | null },
  handle: string
): Promise<string | null> {
  const deadline = Date.now() + PANE_KEY_WAIT_MS
  for (;;) {
    const paneKey = runtime.getTerminalPaneKey(handle)
    if (paneKey || Date.now() >= deadline) {
      return paneKey
    }
    await new Promise((resolve) => setTimeout(resolve, PANE_KEY_POLL_MS))
  }
}

/**
 * `session launch --contract`: once the session is created on THIS host, its Acceptance lines are
 * bound to a verify gate that runs when the session finishes. It answers with the binding's real
 * result (after the first turn starts), so the launcher can retry a lost one; it never launches or
 * re-plans anything, and a second call finds the plan already there.
 */
export const AGENT_SESSION_CONTRACT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'agentSession.attachContractVerify',
    params: z
      .object({
        terminal: requiredString('Missing terminal handle'),
        title: z.string().trim().min(1).max(500),
        acceptance: z.array(z.string().trim().min(1).max(1_000)).min(1).max(32),
        agent: z.enum(['claude', 'codex'])
      })
      .strict(),
    handler: async (params, context) => {
      const { runtime } = context
      const paneKey = await launchedPaneKey(runtime, params.terminal)
      const worktreeId = paneKey ? runtime.getTerminalWorktreeIdForPaneKey(paneKey) : null
      if (!paneKey || !worktreeId) {
        throw new Error('The launched terminal has no conversation identity yet.')
      }
      return attachContractVerify(runtime, {
        worktreeId,
        paneKey,
        title: params.title,
        doneWhen: params.acceptance,
        agent: params.agent,
        label: 'A'
      })
    }
  }),
  defineMethod({
    name: 'agentSession.scheduleFinish',
    params: z
      .object({
        terminal: requiredString('Missing terminal handle'),
        action: z.enum(['archive', 'end']).nullable()
      })
      .strict(),
    handler: async (params, context) => {
      const { runtime } = context
      const paneKey = await launchedPaneKey(runtime, params.terminal)
      if (!paneKey) {
        throw new Error('The launched terminal has no conversation identity yet.')
      }
      return runtime.requestSessionFolders({
        kind: 'scheduleFinish',
        paneKey,
        action: params.action
      })
    }
  }),
  defineMethod({
    name: 'agentSession.markAgentSession',
    params: z
      .object({
        terminal: requiredString('Missing terminal handle')
      })
      .strict(),
    // `session launch`: an agent started it, so it lists in Agent sessions on this host. Why the
    // retried note: a lost one leaves it the person's for good, and a window may still be adding it.
    handler: async (params, context) => {
      const { runtime } = context
      const paneKey = await launchedPaneKey(runtime, params.terminal)
      if (!paneKey) {
        throw new Error('The launched terminal has no conversation identity yet.')
      }
      noteAgentSession(runtime, paneKey)
      return { noted: true }
    }
  })
]
