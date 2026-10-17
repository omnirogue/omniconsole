/**
 * This computer as a relocation DESTINATION: a provider CLI it can run, the workspace the move
 * names (git at the intended commit and clean; a folder that exists), an account with capacity
 * (its own credentials, never the source's), then the same resume `omni session resume` uses,
 * confirmed only by the provider's own report of which conversation it opened.
 */

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { chooseAccountForLaunch } from '../../shared/account-launch-selection'
import type { SessionHostRelocationProvider } from '../../shared/session-host-capabilities'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import { getSelectedClaudeAccountIdForTarget } from '../claude-accounts/runtime-selection'
import { getSelectedCodexAccountIdForTarget } from '../codex-accounts/runtime-selection'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import type { Store } from '../persistence'
import { systemClaudeConfigDir } from '../rate-limits/claude-seat-directory'
import type { RateLimitService } from '../rate-limits/service'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { prepareSessionTarget } from '../runtime/rpc/methods/session-manage-support'
import type { SessionHostWorkspace } from '../session-host/session-host-journal'
import type { SessionResumeLaunch } from './session-manage-resume'
import { runtimeResumeDeps } from './session-manage-resume-runtime'
import type {
  RelocationDestinationCheck,
  RelocationDestinationHost
} from './session-transfer-host-action-deps'
import { localProviderVersion } from './session-transfer-provider-version'

export type RelocationProviderHome = { providerRoot: string } | { refusal: string }

export type RuntimeTransferDestinationWiring = {
  runtime: OrcaRuntimeService
  userDataPath: string
  /** The account home that takes an incoming conversation: one with capacity, never the source's. */
  providerHome(provider: SessionHostRelocationProvider): Promise<RelocationProviderHome>
  signal?: AbortSignal
}

const refuse = (code: 'not-eligible' | 'unsupported-capability', message: string) =>
  ({ ok: false, refusal: sessionHostRefusal(code, `${message} Nothing was changed.`) }) as const

async function isDirectory(path: string): Promise<boolean> {
  return (
    isAbsolute(path) &&
    (await stat(path).then(
      (info) => info.isDirectory(),
      () => false
    ))
  )
}

/** Git at the intended commit with nothing uncommitted; a folder that exists as named. */
async function checkWorkspace(
  workspace: { kind: 'git'; commit: string; path?: string } | { kind: 'folder'; path: string }
): Promise<SessionHostWorkspace | string> {
  const path = workspace.path
  if (!path || !(await isDirectory(path))) {
    return path
      ? `${path} is not a folder on that computer.`
      : 'The move names no workspace path on that computer.'
  }
  if (workspace.kind === 'folder') {
    return { kind: 'folder', path }
  }
  try {
    const head = (await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: path })).stdout.trim()
    const changes = (await gitExecFileAsync(['status', '--porcelain'], { cwd: path })).stdout.trim()
    if (head !== workspace.commit) {
      return `${path} is at commit ${head.slice(0, 12)}, not ${workspace.commit.slice(0, 12)}. Check out that commit there first.`
    }
    return changes ? `${path} has uncommitted changes of its own.` : { kind: 'git', path }
  } catch (error) {
    return `git could not read ${path} (${error instanceof Error ? error.message : String(error)}).`
  }
}

export function runtimeRelocationDestinationHost(
  wiring: RuntimeTransferDestinationWiring
): RelocationDestinationHost {
  const resume = runtimeResumeDeps(wiring.runtime, {
    userDataPath: wiring.userDataPath,
    ...(wiring.signal ? { signal: wiring.signal } : {})
  })
  const launches = new Map<
    string,
    { sessionId: string; agent: SessionHostRelocationProvider; launched: SessionResumeLaunch }
  >()
  return {
    check: async (payload): Promise<RelocationDestinationCheck> => {
      const providerVersion = await localProviderVersion(payload.provider)
      if (!providerVersion) {
        return refuse(
          'unsupported-capability',
          `That computer has no working ${payload.provider} command.`
        )
      }
      const workspace = await checkWorkspace(payload.workspace)
      if (typeof workspace === 'string') {
        return refuse('not-eligible', workspace)
      }
      const home = await wiring.providerHome(payload.provider)
      if ('refusal' in home) {
        return refuse('not-eligible', home.refusal)
      }
      return { ok: true, providerRoot: home.providerRoot, workspace, providerVersion }
    },
    launch: async ({ identity, workspace }) => {
      const launched = await resume.launch({
        reference: { agent: identity.agent, sessionId: identity.sessionId, hostId: 'local' },
        transcriptPath: identity.transcriptPath,
        cwd: workspace.path,
        providerRoot: identity.providerRoot
      })
      if (!launched.paneKey) {
        throw new Error(
          `It started in terminal ${launched.terminal}, but its pane could not be read.`
        )
      }
      const prepared = await prepareSessionTarget(wiring.runtime, { paneKey: launched.paneKey })
      launches.set(launched.paneKey, {
        sessionId: identity.sessionId,
        agent: identity.agent,
        launched
      })
      return {
        binding: { worktreeId: prepared.row.worktreeId, paneKey: launched.paneKey, kind: 'pty' },
        processIncarnation: prepared.agentProcess
          ? `${prepared.agentProcess.ptyId}:${prepared.agentProcess.incarnationId ?? prepared.agentProcess.pid}`
          : null
      }
    },
    confirm: async (binding) => {
      const started = launches.get(binding.paneKey)
      if (!started) {
        return { state: 'unconfirmed' }
      }
      const verdict = await resume.confirm(
        { agent: started.agent, sessionId: started.sessionId, hostId: 'local' },
        started.launched
      )
      return verdict.state === 'same'
        ? { state: 'same' }
        : verdict.state === 'different'
          ? { state: 'different', reported: verdict.reported }
          : { state: 'unconfirmed' }
    }
  }
}

const HOME_VARIABLE = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' } as const

/** The balanced account launches use, so a move lands where there is capacity to run it. */
export function runtimeRelocationProviderHome(services: {
  store: Pick<Store, 'getSettings'>
  rateLimits: Pick<RateLimitService, 'getState'>
}): (provider: SessionHostRelocationProvider) => Promise<RelocationProviderHome> {
  return async (provider) => {
    const settings = services.store.getSettings()
    const state = services.rateLimits.getState()
    const target = { runtime: 'host' as const, wslDistro: null }
    const account =
      provider === 'claude'
        ? chooseAccountForLaunch({
            provider,
            accounts: settings.claudeManagedAccounts,
            defaultAccountId: getSelectedClaudeAccountIdForTarget(settings, target),
            target,
            rateLimits: state
          })
        : chooseAccountForLaunch({
            provider,
            accounts: settings.codexManagedAccounts ?? [],
            defaultAccountId: getSelectedCodexAccountIdForTarget(settings, target),
            target,
            rateLimits: state
          })
    const chosen = account?.launchEnv?.[HOME_VARIABLE[provider]]
    if (chosen) {
      return { providerRoot: chosen }
    }
    if (!account && state.accountCapacity?.[provider]) {
      return {
        refusal: `Every ${provider} account on that computer is signed out or at its limit.`
      }
    }
    if (account && 'managedHomePath' in account) {
      return { providerRoot: account.managedHomePath }
    }
    if (account && 'managedAuthPath' in account) {
      return { providerRoot: join(account.managedAuthPath, 'session') }
    }
    return {
      providerRoot:
        provider === 'claude'
          ? systemClaudeConfigDir()
          : process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
    }
  }
}
