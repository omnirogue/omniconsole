import type { CreateWebRuntimeSessionTerminalArgs } from './web-runtime-session-types'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { toHostSessionTabId } from './web-terminal-surface-id'

export function webRuntimeLegacyTerminalCreateParams(args: CreateWebRuntimeSessionTerminalArgs) {
  return {
    worktree: toRuntimeWorktreeSelector(args.worktreeId),
    afterTabId: args.afterTabId ? toHostSessionTabId(args.afterTabId) : undefined,
    targetGroupId: args.targetGroupId,
    command: args.command,
    cwd: args.cwd,
    ...(args.env ? { env: args.env } : {}),
    ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
    startupCommandDelivery: args.startupCommandDelivery,
    ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
    ...(args.launchToken ? { launchToken: args.launchToken } : {}),
    ...(args.agent ? { agent: args.agent } : {}),
    ...(args.launchAgent ? { launchAgent: args.launchAgent } : {}),
    ...(args.viewMode ? { viewMode: args.viewMode } : {}),
    // Older hosts use activate; current hosts select through the calling client.
    activate: false,
    select: args.activate !== false,
    navigation: 'caller' as const,
    ...(args.clientMutationId ? { clientMutationId: args.clientMutationId } : {})
  }
}
