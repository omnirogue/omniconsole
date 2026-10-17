import type { LaunchCause } from '../../../shared/launch-cause'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../omni-runtime'

export async function createDesktopCoordinator(
  runtime: OrcaRuntimeService,
  worktreeId: string,
  title: string,
  opts: {
    launchCause: LaunchCause
    preAllocatedHandle?: string
    paneIdentity?: { tabId: string; leafId: string }
  }
): Promise<string> {
  const terminal = await runtime.createTerminal(`id:${worktreeId}`, {
    title,
    surfaceOwner: false,
    launchCause: opts.launchCause,
    ...(opts.preAllocatedHandle ? { preAllocatedHandle: opts.preAllocatedHandle } : {}),
    ...(opts.paneIdentity ? opts.paneIdentity : {})
  })
  const deadline = Date.now() + 15_000
  let paneKey = runtime.getTerminalPaneKey(terminal.handle)
  while (!paneKey) {
    if (Date.now() > deadline) {
      throw new Error('The coordinator terminal never received a stable pane identity.')
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    paneKey = runtime.getTerminalPaneKey(terminal.handle)
  }
  if (opts.paneIdentity && parsePaneKey(paneKey)?.leafId !== opts.paneIdentity.leafId) {
    throw new Error('The coordinator terminal did not adopt its durable pane identity.')
  }
  return terminal.handle
}
