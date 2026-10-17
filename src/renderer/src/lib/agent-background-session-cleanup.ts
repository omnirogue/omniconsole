import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { retireProvider } from '@/lib/retire-unowned-background-terminal'

export function runBestEffortAgentBackgroundCleanups(...actions: (() => void)[]): void {
  for (const action of actions) {
    try {
      action()
    } catch {
      // Preserve the launch/setup error that triggered cleanup.
    }
  }
}

/**
 * Tears down a background agent launch that failed between its separate remote
 * calls (spawn, subscribe, adopt): nothing invisible may survive. The `store` slice is
 * structural so the caller passes the live store without widening this module's deps.
 */
export async function abandonAgentBackgroundLaunch(args: {
  ptyId: string
  paneKey: string
  tabId: string | null
  runtimeTarget: RuntimeClientTarget
  runtimeTerminalHandle: string | null
  unsubscribeExit: () => void
  unsubscribeData: () => void
  disposeEagerPtyBuffer: () => void
  clearSshStartupDelivery: () => void
  store: {
    clearTabPtyId: (tabId: string, ptyId: string) => void
    clearAgentLaunchConfig: (paneKey: string) => void
    closeTab: (tabId: string, options: { recordInteraction: false; reason: 'cleanup' }) => void
  }
}): Promise<void> {
  const { ptyId, tabId, store } = args
  runBestEffortAgentBackgroundCleanups(args.unsubscribeExit, args.unsubscribeData)
  runBestEffortAgentBackgroundCleanups(args.disposeEagerPtyBuffer, args.clearSshStartupDelivery)
  if (tabId) {
    runBestEffortAgentBackgroundCleanups(() => store.clearTabPtyId(tabId, ptyId))
  }
  runBestEffortAgentBackgroundCleanups(() => store.clearAgentLaunchConfig(args.paneKey))
  if (ptyId) {
    await retireProvider({
      ptyId,
      runtimeTarget: args.runtimeTarget,
      runtimeTerminalHandle: args.runtimeTerminalHandle
    })
  }
  if (tabId) {
    // Cleanup closes must not enter the reopen stack.
    runBestEffortAgentBackgroundCleanups(() =>
      store.closeTab(tabId, { recordInteraction: false, reason: 'cleanup' })
    )
  }
}
