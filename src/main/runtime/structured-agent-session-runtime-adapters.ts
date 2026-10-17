// The structured-session adapters the runtime installs, and the router over them.
//
// Lifted out of structured-agent-session-runtime.ts so that file stays inside
// its line budget. The Codex unexpected-exit callback is passed in rather than
// built here: it has to close over the host and the recovery chain the runtime
// owns, and serializing recovery against teardown is the runtime's job.

import { createAcpStructuredSessionAdapter } from '../acp/acp-structured-launch'
import { createStructuredClaudeRuntimeAdapter } from './structured-claude-runtime-adapter'
import { CodexStructuredSessionAdapter } from '../codex/codex-structured-session-adapter'
import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
import { isOmniConsoleMcpDefaultRequested } from '../mcp/omni-console-mcp-launch-context'
import { prepareOmniConsoleMcpForLaunch } from '../mcp/omni-console-mcp-launch'
import { readProcessStartTimeMs } from './agent-session-process-identity-probe'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'

export function createStructuredAgentSessionAdapters(input: {
  deps: StructuredAgentSessionRuntimeDeps
  store: AgentSessionRecordStore
  bootEnvironment: Promise<NodeJS.ProcessEnv>
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  /** Called only for an adapter exit the provider did not ask for. */
  onUnexpectedExit: (event: StructuredAgentSessionLifecycleEvent) => void
  /** Called when a provider's background-task roster changes, for the host to publish. */
  onBackgroundTasksChanged?: (
    sessionId: string,
    state: AgentSessionBackgroundTaskState | null
  ) => void
}): StructuredAgentSessionAdapterRouter {
  const { deps, store } = input
  const codex = new CodexStructuredSessionAdapter({
    resolveLaunch: createCodexStructuredLaunchResolver({
      store,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      resolveEnvironment: input.resolveEnvironment,
      prepareMcp: ({ cwd, env }) =>
        prepareOmniConsoleMcpForLaunch({
          provider: 'codex',
          cwd,
          env,
          signedIn: isOmniConsoleMcpDefaultRequested(deps.stateDirectory)
        }),
      ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {})
    }),
    ...(deps.openCodexConnection ? { openConnection: deps.openCodexConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    onEvent: (event) => {
      if (event.type !== 'ended' || !('cause' in event) || event.cause !== 'unexpected-exit') {
        return
      }
      input.onUnexpectedExit(event)
    }
  })
  const acpEnabled = deps.acpEnabled ?? (() => false)
  const acp = createAcpStructuredSessionAdapter({
    store,
    resolveWorkspacePath: deps.resolveWorkspacePath,
    resolveEnvironment: deps.resolveAcpEnvironment ?? (() => input.bootEnvironment),
    readProcessStartTime: deps.readProcessStartTime ?? readProcessStartTimeMs,
    enabled: acpEnabled,
    settings: deps.acpSettings,
    ...(deps.openAcpConnection ? { openConnection: deps.openAcpConnection } : {})
  })
  const claude = createClaudeStructuredAdapter(input)
  return new StructuredAgentSessionAdapterRouter({
    codex,
    acp,
    ...(claude && deps.claudeStructuredEnabled
      ? { claude, claudeEnabled: deps.claudeStructuredEnabled }
      : {}),
    acpEnabled,
    record: (id) => store.getRecord(id)
  })
}

/**
 * The Claude Agent SDK lane, or null when this host cannot offer it.
 *
 * Fails closed by construction: without an auth-policy resolver there is no
 * truthful answer to "which managed account is this session running as", and a
 * session that guesses authenticates as whatever the ambient identity happens to
 * be. Absent here means Claude keeps the lane it had before the SDK existed.
 */
function createClaudeStructuredAdapter(
  input: Parameters<typeof createStructuredAgentSessionAdapters>[0]
): ReturnType<typeof createStructuredClaudeRuntimeAdapter> | null {
  const { deps, store } = input
  if (!deps.resolveClaudeAuthPolicy || !deps.claudeStructuredEnabled) {
    return null
  }
  return createStructuredClaudeRuntimeAdapter({
    store,
    resolveWorkspacePath: deps.resolveWorkspacePath,
    resolveClaudeAuthPolicy: deps.resolveClaudeAuthPolicy,
    ...(deps.resolveClaudeCommand ? { resolveClaudeCommand: deps.resolveClaudeCommand } : {}),
    ...(deps.resolveClaudeLaunchEnv ? { resolveClaudeLaunchEnv: deps.resolveClaudeLaunchEnv } : {}),
    ...(deps.readClaudeManagedAccountGate
      ? { readClaudeManagedAccountGate: deps.readClaudeManagedAccountGate }
      : {}),
    ...(deps.openClaudeConnection ? { openClaudeConnection: deps.openClaudeConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    onUnexpectedExit: input.onUnexpectedExit,
    ...(input.onBackgroundTasksChanged
      ? { onBackgroundTasksChanged: input.onBackgroundTasksChanged }
      : {})
  })
}
