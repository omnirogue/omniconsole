import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { resolveAgentAccountLaunchEnv } from '../../shared/agent-account-profiles'
import {
  assistedBriefCancelRequest,
  assistedBriefGenerateRequest,
  type AssistedBriefGenerateRequest,
  type AssistedBriefGenerateResult
} from '../../shared/assisted-brief-contract'
import { getCommitMessageAgentSpec } from '../../shared/commit-message-agent-spec'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../text-generation/commit-message-agent-environment'
import {
  cancelAssistedBriefTextLocal,
  generateAssistedBriefTextFromPrompt,
  type CommitMessageGenerationTarget
} from '../text-generation/commit-message-text-generation'
import { resolveModelDiscoveryLocalPath } from './filesystem'
import { getLocalGitOptionsForRegisteredWorktree } from './local-worktree-runtime-options'

export type AssistedBriefDeps = {
  store: Store
  agentEnv?: CommitMessageAgentEnvironmentResolvers
}

export type OneShotWorkspaceTarget = Pick<
  AssistedBriefGenerateRequest,
  'worktreePath' | 'connectionId' | 'agent' | 'accountChoiceId'
>

/** Where a read-only one-shot runs: the workspace's SSH host, WSL distro or this computer. */
export async function resolveBriefTarget(
  deps: AssistedBriefDeps,
  request: OneShotWorkspaceTarget
): Promise<CommitMessageGenerationTarget | { error: string }> {
  if (request.connectionId) {
    const provider = getSshGitProvider(request.connectionId)
    if (!provider) {
      return { error: SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE }
    }
    return {
      kind: 'remote',
      cwd: request.worktreePath,
      execute: (plan, cwd, timeoutMs, operation) =>
        provider.executeCommitMessagePlan(plan, cwd, timeoutMs, operation),
      missingBinaryLocation: 'remote PATH'
    }
  }
  const cwd = await resolveModelDiscoveryLocalPath(deps.store, request.worktreePath)
  const { wslDistro } = getLocalGitOptionsForRegisteredWorktree(
    deps.store,
    request.worktreePath,
    cwd
  )
  // Why: the favourite's saved account drafts too; main resolves it from its own settings
  // rather than trusting an environment sent by the renderer.
  const accountEnv = wslDistro
    ? undefined
    : resolveAgentAccountLaunchEnv(deps.store.getSettings(), request.agent, request.accountChoiceId)
  const prepared = await prepareLocalCommitMessageAgentEnv(
    request.agent,
    deps.agentEnv,
    wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' },
    accountEnv
  )
  if (!prepared.ok) {
    return { error: prepared.error }
  }
  const env = accountEnv ? { ...(prepared.env ?? process.env), ...accountEnv } : prepared.env
  return { kind: 'local', cwd, ...(wslDistro ? { wslDistro } : {}), ...(env ? { env } : {}) }
}

/** One read-only draft or review. The one-shot agent spec keeps the agent from changing files. */
export async function generateAssistedBrief(
  deps: AssistedBriefDeps,
  raw: unknown
): Promise<AssistedBriefGenerateResult> {
  const parsed = assistedBriefGenerateRequest.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: 'The brief request was not valid.' }
  }
  const request = parsed.data
  const spec = getCommitMessageAgentSpec(request.agent)
  if (!spec) {
    return { ok: false, error: `${request.agent} cannot draft briefs.` }
  }
  let target: CommitMessageGenerationTarget | { error: string }
  try {
    target = await resolveBriefTarget(deps, request)
  } catch {
    return { ok: false, error: 'This workspace could not be opened for drafting.' }
  }
  if ('error' in target) {
    return { ok: false, error: target.error }
  }
  const agentCommandOverride = deps.store.getSettings().agentCmdOverrides?.[request.agent]?.trim()
  const result = await generateAssistedBriefTextFromPrompt(
    request.prompt,
    {
      agentId: request.agent,
      model: request.model ?? spec.defaultModelId,
      ...(request.effort ? { thinkingLevel: request.effort } : {}),
      ...(agentCommandOverride ? { agentCommandOverride } : {})
    },
    target
  )
  return result.success
    ? { ok: true, text: result.rawOutput, actorLabel: result.agentLabel ?? spec.label }
    : { ok: false, error: result.error, ...(result.canceled ? { canceled: true } : {}) }
}

export async function cancelAssistedBrief(store: Store, raw: unknown): Promise<void> {
  const parsed = assistedBriefCancelRequest.safeParse(raw)
  if (!parsed.success) {
    return
  }
  const { worktreePath, connectionId } = parsed.data
  if (connectionId) {
    await getSshGitProvider(connectionId)?.cancelNonInteractiveExec(worktreePath, 'assisted-brief')
    return
  }
  try {
    cancelAssistedBriefTextLocal(await resolveModelDiscoveryLocalPath(store, worktreePath))
  } catch {
    // Why: a path that is not a registered workspace has nothing running to cancel.
  }
}

export function registerAssistedBriefHandlers(
  store: Store,
  agentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  const deps: AssistedBriefDeps = { store, ...(agentEnv ? { agentEnv } : {}) }
  ipcMain.handle('assistedBrief:generate', (_event, args) => generateAssistedBrief(deps, args))
  ipcMain.handle('assistedBrief:cancel', (_event, args) => cancelAssistedBrief(store, args))
}
