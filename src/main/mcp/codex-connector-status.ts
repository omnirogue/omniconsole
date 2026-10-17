import { runCodexAppServerSession } from '../codex/codex-app-server-session'
import { resolveCodexCommand } from '../codex-cli/command'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import type { ConnectorStatus } from '../../shared/mcp-connectors'

export async function checkCodexConnector(home: string, name: string): Promise<ConnectorStatus> {
  const command = resolveCodexCommand()
  try {
    return await runCodexAppServerSession(
      {
        command,
        cliPath: command,
        args: [...CODEX_READ_ONLY_APP_SERVER_ARGS],
        env: { CODEX_HOME: home },
        timeoutMs: 30_000
      },
      async (rpc) => {
        const result = await rpc.request('mcpServerStatus/list', { serverName: name, limit: 100 })
        if (
          !result ||
          typeof result !== 'object' ||
          !('data' in result) ||
          !Array.isArray(result.data)
        ) {
          return 'unavailable'
        }
        const server = result.data.find((entry) => entry?.name === name)
        if (!server) {
          return 'unavailable'
        }
        if (
          server.runtimeStatus === 'authenticationRequired' ||
          server.authStatus === 'notLoggedIn'
        ) {
          return 'needs-sign-in'
        }
        if (
          server.toolsError ||
          ['failed', 'cancelled', 'disabled'].includes(server.runtimeStatus)
        ) {
          return 'unavailable'
        }
        if (
          server.runtimeStatus === 'connected' ||
          (server.serverInfo && server.serverCapabilities)
        ) {
          return 'connected'
        }
        return server.authStatus === 'oAuth' ? 'signed-in' : 'configured'
      }
    )
  } catch {
    return 'unavailable'
  }
}
