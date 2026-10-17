import type { AgentSessionClaimedSpawnResult } from '../../../../shared/agent-session-host-authority'
import type { PtyLaunchGateReceipt } from '../../../../shared/pty-launch-gate'

export function toRuntimeSpawnReply(result: {
  id: string
  pid?: number | null
  launchGate?: PtyLaunchGateReceipt
  incarnationId?: string
  wslDistro?: string | null
  stablePaneOwner?: { handle: string; tabId: string; leafId: string }
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
}) {
  return {
    id: result.id,
    ...(Number.isSafeInteger(result.pid) && Number(result.pid) > 0
      ? { pid: Number(result.pid) }
      : {}),
    ...(result.launchGate ? { launchGate: result.launchGate } : {}),
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
    ...(typeof result.wslDistro === 'string' ? { wslDistro: result.wslDistro } : {}),
    ...(result.stablePaneOwner ? { stablePaneOwner: result.stablePaneOwner } : {}),
    ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {})
  }
}
