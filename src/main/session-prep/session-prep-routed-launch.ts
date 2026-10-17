import { CLAUDE_AUTH_ENV_VARS } from '../../shared/claude-auth-env'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import { isWslUncPath } from '../../shared/wsl-paths'
import type { TuiAgent } from '../../shared/tui-agent'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { discoverAgentSessionAccountCatalog } from '../runtime/agent-session-account-model-catalog'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import type { SessionPrepWorkspace } from './session-prep-host'
import { SessionPrepHostError } from './session-prep-execution-host'

export type SessionPrepRoutedLaunch = {
  workspace: SessionPrepWorkspace
  agent: TuiAgent
  launch: AgentLaunchPreferences
  /** Present only when the effective model came from a live automatic route. */
  routedModel: string
  accountEnv?: Record<string, string>
}

export class SessionPrepRoutedModelUnavailableError extends SessionPrepHostError {}

/** Resolve the ordinary launch account once, then freeze its environment through model check and spawn. */
export async function prepareSessionPrepRoutedLaunch(
  input: SessionPrepRoutedLaunch,
  dependencies: {
    configuredEnv: Record<string, string>
    commandOverride?: string
    resolvers?: CommitMessageAgentEnvironmentResolvers
    catalog?: typeof discoverAgentSessionAccountCatalog
  }
): Promise<Record<string, string>> {
  const refuse = (): never => {
    throw new SessionPrepRoutedModelUnavailableError(
      `The launch account could not verify routed model ${input.routedModel}. Refresh its model listing or select an available model explicitly, then prepare again. Nothing launched.`
    )
  }
  if (
    input.launch.model !== input.routedModel ||
    !['claude', 'codex'].includes(input.agent) ||
    (!input.workspace.connectionId &&
      (process.platform === 'win32' || isWslUncPath(input.workspace.path)))
  ) {
    return refuse()
  }
  let env: Record<string, string>
  try {
    if (input.workspace.connectionId) {
      // Remote account selection already ran on the execution host; never fall back locally.
      if (!input.accountEnv) {
        return refuse()
      }
      env = { ...input.accountEnv }
    } else {
      env = { ...dependencies.configuredEnv }
      const target = { runtime: 'host' as const }
      if (input.agent === 'codex') {
        const prepare = dependencies.resolvers?.prepareForCodexLaunch
        if (!prepare) {
          return refuse()
        }
        const home = await prepare(target, { ...env })
        // The existing resolver returns null for the system real-home lane.
        env.CODEX_HOME = home ?? getSystemCodexHomePath()
      } else {
        const prepare = dependencies.resolvers?.prepareForClaudeLaunch
        if (!prepare) {
          return refuse()
        }
        const prepared = await prepare(target, { env: { ...env } })
        if (prepared.runtime === 'wsl') {
          return refuse()
        }
        if (prepared.stripAuthEnv) {
          for (const key of CLAUDE_AUTH_ENV_VARS) {
            env[key] = ''
          }
          env.ANTHROPIC_CUSTOM_HEADERS = ''
        }
        Object.assign(env, prepared.envPatch, { CLAUDE_CONFIG_DIR: prepared.configDir })
      }
    }
    const hostId =
      input.workspace.hostId ??
      (input.workspace.connectionId ? `ssh:${input.workspace.connectionId}` : 'local')
    const catalog = await (dependencies.catalog ?? discoverAgentSessionAccountCatalog)(
      {
        brief: '',
        title: '',
        provider: input.agent,
        executionTarget: { ...input.workspace, hostId }
      },
      env,
      dependencies.commandOverride
    )
    const model = catalog.agents
      .find((entry) => entry.provider === input.agent && entry.discovered)
      ?.models.find((entry) => entry.id === input.routedModel)
    if (
      catalog.hostId !== hostId ||
      !model ||
      (input.launch.effort &&
        !model.thinkingLevels?.some((level) => level.id === input.launch.effort))
    ) {
      return refuse()
    }
    return env
  } catch {
    return refuse()
  }
}

export async function prepareSessionPrepLaunchEnvironment(
  runtime: {
    prepareSessionPrepRoutedLaunch?: (
      input: SessionPrepRoutedLaunch
    ) => Promise<Record<string, string>>
  },
  workspace: SessionPrepRoutedLaunch['workspace'],
  args: { agent: TuiAgent; launch?: AgentLaunchPreferences; routedModel?: string },
  env?: Record<string, string>
): Promise<Record<string, string> | undefined> {
  if (!args.routedModel) {
    return env
  }
  if (!args.launch || !runtime.prepareSessionPrepRoutedLaunch) {
    throw new SessionPrepRoutedModelUnavailableError(
      'This runtime cannot verify the routed model on its launch account. Update the runtime or choose a model explicitly. Nothing launched.'
    )
  }
  return runtime.prepareSessionPrepRoutedLaunch({
    workspace,
    agent: args.agent,
    launch: args.launch,
    routedModel: args.routedModel,
    ...(env ? { accountEnv: env } : {})
  })
}
