import type { TuiAgent } from '../../../shared/tui-agent'
import { requireTuiAgentConfig } from '../../../shared/require-tui-agent-config'

export async function markAgentBackgroundWorkspaceTrusted(
  agent: TuiAgent,
  workspacePath: string,
  connectionId: string | null
): Promise<void> {
  const preset = requireTuiAgentConfig(agent).preflightTrust
  if (!preset || !workspacePath || !window.api.agentTrust?.markTrusted) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset,
      workspacePath,
      ...(connectionId ? { connectionId } : {})
    })
  } catch {
    // Best-effort: the user can still accept the trust prompt.
  }
}
