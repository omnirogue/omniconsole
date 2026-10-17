import { randomUUID } from 'node:crypto'
import type { PrepRunText } from '../../shared/session-prep-types'
import { getCommitMessageAgentSpec } from '../../shared/commit-message-agent-spec'
import type { Store } from '../persistence'
import { resolveModelDiscoveryLocalPath } from '../ipc/model-discovery-local-path'
import { getLocalGitOptionsForRegisteredWorktree } from '../ipc/local-worktree-runtime-options'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../text-generation/commit-message-agent-environment'
import { generateSessionPrepTextFromPrompt } from '../text-generation/commit-message-text-generation'

import { SessionPrepAccountPreparationError } from './session-prep-ids'
import type { CommitMessageGenerationTarget } from '../text-generation/commit-message-text-generation'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { prepareSessionPrepRemoteAccount } from './session-prep-remote-account'

export function createSessionPrepTextRunner(
  store: Store,
  agentEnv: () => CommitMessageAgentEnvironmentResolvers | undefined
): PrepRunText {
  return async (request) => {
    const spec = getCommitMessageAgentSpec(request.agent)
    if (!spec) {
      throw new Error(`${request.agent} cannot draft session prep text.`)
    }
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort()
        reject(new Error(`Session prep text timed out after ${request.timeoutMs}ms.`))
      }, request.timeoutMs)
    })
    const generate = async () => {
      let target: CommitMessageGenerationTarget
      if (request.connectionId) {
        const provider = requireSshGitProvider(request.connectionId)
        const env = await prepareSessionPrepRemoteAccount(
          request.connectionId,
          request.agent,
          request.model
        )
        abort.signal.throwIfAborted()
        // Each call owns its cancellation lane; sibling prepares cannot queue behind expired work.
        const operation = `session-prep:${randomUUID()}`
        target = {
          kind: 'remote',
          cwd: request.cwd,
          missingBinaryLocation: 'remote PATH',
          execute: (plan, cwd, timeoutMs) =>
            provider.executeCommitMessagePlan(
              plan,
              cwd,
              Math.min(timeoutMs, request.timeoutMs),
              operation,
              env,
              abort.signal
            )
        }
      } else {
        target = await localTarget(request.cwd, request.agent, store, agentEnv)
      }
      abort.signal.throwIfAborted()
      const override = store.getSettings().agentCmdOverrides?.[request.agent]?.trim()
      return generateSessionPrepTextFromPrompt(
        request.prompt,
        {
          agentId: request.agent,
          model: request.model ?? spec.defaultModelId,
          ...(request.effort ? { thinkingLevel: request.effort } : {}),
          ...(override ? { agentCommandOverride: override } : {})
        },
        target
      )
    }
    try {
      const result = await Promise.race([generate(), timeout])
      if (!result.success) {
        throw new Error(result.error)
      }
      return result.rawOutput
    } finally {
      clearTimeout(timer)
      abort.abort()
    }
  }
}

async function localTarget(
  path: string,
  agent: Parameters<PrepRunText>[0]['agent'],
  store: Store,
  agentEnv: () => CommitMessageAgentEnvironmentResolvers | undefined
): Promise<CommitMessageGenerationTarget> {
  const cwd = await resolveModelDiscoveryLocalPath(store, path)
  const { wslDistro } = getLocalGitOptionsForRegisteredWorktree(store, path, cwd)
  const resolvers = agentEnv()
  if (
    (agent === 'claude' && !resolvers?.prepareForClaudeLaunch) ||
    (agent === 'codex' && !resolvers?.prepareForCodexLaunch)
  ) {
    throw new SessionPrepAccountPreparationError(
      'Session prep account routing is not available yet.'
    )
  }
  const prepared = await prepareLocalCommitMessageAgentEnv(
    agent,
    resolvers,
    wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' }
  )
  if (!prepared.ok) {
    throw new SessionPrepAccountPreparationError(prepared.error)
  }
  return {
    kind: 'local' as const,
    cwd,
    ...(wslDistro ? { wslDistro } : {}),
    ...(prepared.env ? { env: prepared.env } : {})
  }
}
