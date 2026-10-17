import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { MAX_AGENT_STATE_FILE_BYTES } from '../agent-state-file-reader'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { resolveNewAgentSessionDefaults } from './new-agent-session-defaults'
import { resolveTuiAgentLaunchArgs } from '../../shared/tui-agent-launch-defaults'
import { getWslHomeAsync } from '../wsl'
import { parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import { joinWorktreeRelativePath } from './runtime-relative-paths'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  discoverCommitMessageModelsLocal,
  discoverCommitMessageModelsRemote
} from '../text-generation/commit-message-text-generation'

export function resolveNewAgentSessionDefaultsOnHost(input: {
  agent: TuiAgent
  options?: Readonly<Record<string, string>>
  settings: GlobalSettings
  env?: Readonly<Record<string, string | undefined>>
  accountHome?: string
  workspacePath: string
  connectionId?: string | null
  agentArgs?: string | null
}) {
  const wsl = !input.connectionId ? parseWslUncPath(input.workspacePath) : null
  const provider = input.connectionId ? getSshFilesystemProvider(input.connectionId) : null
  return resolveNewAgentSessionDefaults({
    ...input,
    persisted: input.settings.nativeChatSessionOptions,
    commandOverride: input.settings.agentCmdOverrides?.[input.agent],
    agentArgs:
      input.agentArgs === undefined
        ? resolveTuiAgentLaunchArgs(input.agent, input.settings.agentDefaultArgs)
        : input.agentArgs,
    resolveAccountHome: async () => {
      if (wsl) {
        if (input.accountHome) {
          return input.accountHome.startsWith('/')
            ? toWindowsWslPath(input.accountHome, wsl.distro)
            : input.accountHome
        }
        const home = await getWslHomeAsync(wsl.distro)
        return home
          ? joinWorktreeRelativePath(home, input.agent === 'codex' ? '.codex' : '.claude')
          : undefined
      }
      if (input.accountHome) {
        return input.accountHome
      }
      const home = await provider?.getHomeDir?.()
      return home
        ? joinWorktreeRelativePath(home, input.agent === 'codex' ? '.codex' : '.claude')
        : undefined
    },
    discoverModels: async (accountHome) => {
      try {
        const accountEnv = {
          ...input.env,
          CODEX_HOME: parseWslUncPath(accountHome)?.linuxPath ?? accountHome
        }
        const gitProvider = input.connectionId ? getSshGitProvider(input.connectionId) : null
        const result = input.connectionId
          ? gitProvider
            ? await discoverCommitMessageModelsRemote(
                'codex',
                input.workspacePath,
                (plan, cwd, timeoutMs) =>
                  gitProvider.executeCommitMessagePlan(
                    {
                      ...plan,
                      binary: 'env',
                      args: [`CODEX_HOME=${accountHome}`, plan.binary, ...plan.args]
                    },
                    cwd,
                    Math.min(timeoutMs, 3_000)
                  )
              )
            : null
          : await discoverCommitMessageModelsLocal(
              'codex',
              { ...process.env, ...accountEnv },
              undefined,
              {
                cwd: input.workspacePath,
                signal: AbortSignal.timeout(3_000),
                ...(wsl ? { wslDistro: wsl.distro } : {})
              }
            )
        // A static seed/fallback does not establish this exact execution account's eligibility.
        return result?.success && result.catalogOrigin === 'probe' ? result.models : null
      } catch {
        return null
      }
    },
    readFile: async (path) => {
      try {
        if (!input.connectionId) {
          return (await readNodeFileWithinLimit(path, MAX_AGENT_STATE_FILE_BYTES)).buffer.toString(
            'utf8'
          )
        }
        if (!provider) {
          throw new Error('The execution host filesystem is unavailable.')
        }
        const result = await provider.readFile(path, {
          maxTextBytes: MAX_AGENT_STATE_FILE_BYTES,
          maxBinaryBytes: MAX_AGENT_STATE_FILE_BYTES
        })
        if (result.isBinary) {
          throw new Error('The execution host settings are unreadable.')
        }
        if (Buffer.byteLength(result.content) > MAX_AGENT_STATE_FILE_BYTES) {
          throw new Error('The execution host settings exceed the read limit.')
        }
        return result.content
      } catch (error) {
        if (isDefinitiveAbsence(error)) {
          return null
        }
        throw error
      }
    }
  })
}
