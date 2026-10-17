import { assertOmpRouteVersion } from '../omp/omp-route-version'
import { writeOmpRouteConfig } from '../omp/omp-route-config'
import { openrouterCandidates } from '../../shared/openrouter-route'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  isAcpStructuredAgent,
  acpAccountHomeVariable,
  acpSpawnRecipe
} from '../../shared/acp-agent-recipes'
import { CODEX_SPAWN_TOKEN_ENV } from '../codex/codex-structured-owner-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import type { AcpJsonRpcLaunch, openAcpJsonRpcConnection } from './acp-jsonrpc-connection'
import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import { structuredSessionOutcomeEnvironment } from '../native-chat/agent-session-wire/structured-agent-session-outcome-environment'

export function createAcpStructuredSessionAdapter(input: {
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  readProcessStartTime: (pid: number) => Promise<number | null>
  openConnection?: typeof openAcpJsonRpcConnection
  enabled?: (agent: string) => boolean
  settings?: () => GlobalSettings
}): AcpStructuredSessionAdapter {
  return new AcpStructuredSessionAdapter({
    resolveLaunch: (launchInput) =>
      resolveAcpStructuredLaunch({
        identity: launchInput.identity,
        spawnToken: launchInput.spawnToken,
        store: input.store,
        resolveWorkspacePath: input.resolveWorkspacePath,
        resolveEnvironment: async () => ({
          ...(await input.resolveEnvironment()),
          ...(isAcpStructuredAgent(launchInput.identity.agent)
            ? resolveTuiAgentLaunchEnv(
                launchInput.identity.agent,
                input.settings?.().agentDefaultEnv
              )
            : {})
        })
      }),
    readProcessStartTime: input.readProcessStartTime,
    ...(input.openConnection ? { openConnection: input.openConnection } : {}),
    ...(input.enabled ? { enabled: input.enabled } : {})
  })
}

export async function resolveAcpStructuredLaunch(input: {
  identity: AgentSessionJournalIdentity
  spawnToken: string
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
}): Promise<AcpJsonRpcLaunch> {
  const recipe = acpSpawnRecipe(input.identity.agent)
  if (!recipe) {
    throw new Error(`ACP Chat UI does not support ${input.identity.agent}`)
  }
  const record = input.store.getRecord(input.identity.sessionId)
  if (
    record &&
    (record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      record.location.wslDistro !== null)
  ) {
    throw new Error(
      `ACP structured sessions run on the local host, not ${record.location.executionHostId}`
    )
  }
  const workspacePath = await input.resolveWorkspacePath(input.identity.workspaceId)
  const environment = await input.resolveEnvironment()
  if (input.identity.agent === 'omp') {
    await assertOmpRouteVersion(environment)
  }
  const homeVariable = record?.accountHome.variable ?? acpAccountHomeVariable(input.identity.agent)
  const homePath = record?.accountHome.path
  return {
    command: recipe.program,
    args: [
      ...recipe.args,
      ...(input.identity.agent === 'omp'
        ? [
            ...(record?.options?.model ? ['--model', record.options.model] : []),
            '--config',
            writeOmpRouteConfig({
              model: record?.options?.model,
              ...(record?.options?.openrouterCandidates !== undefined
                ? {
                    openrouterCandidates: openrouterCandidates.parse(
                      JSON.parse(record!.options!.openrouterCandidates)
                    )
                  }
                : {})
            })
          ]
        : [])
    ],
    cwd: workspacePath,
    env: {
      ...(environment as Record<string, string>),
      ...(homeVariable && homePath ? { [homeVariable]: homePath } : {}),
      ...structuredSessionOutcomeEnvironment(input.identity),
      [CODEX_SPAWN_TOKEN_ENV]: input.spawnToken
    }
  }
}
