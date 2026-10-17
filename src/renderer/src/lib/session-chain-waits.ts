import {
  createTerminalWaitDependencies,
  SourceSessionBlockedError,
  waitForSourceSessionCompletion
} from '@/lib/next-session-launch'
import { withResolveRetry, workspaceRuntimeTarget } from '@/lib/session-chain-support'
import type { SourceStop } from '@/lib/session-follow-up-step'
import type { SessionChain } from '../../../shared/session-chain-types'

/** The panes a step waits on, once finished; `exited` is only known when the wait itself saw the exit. */
export type SourceStops = { keys: string; stops: SourceStop[] }

/**
 * Wait for every pane a step depends on. One branch failing aborts the others' waits,
 * so a chain marked failed leaves no wait polling behind it.
 */
export async function waitForAllStops(
  chain: SessionChain,
  sourcePaneKeys: readonly string[],
  signal: AbortSignal
): Promise<SourceStop[]> {
  const local = new AbortController()
  const stopLocal = (): void => local.abort()
  signal.addEventListener('abort', stopLocal)
  try {
    return await Promise.all(
      sourcePaneKeys.map(async (sourcePaneKey) => {
        try {
          const worktreeId =
            sourcePaneKey === chain.sourcePaneKey
              ? (chain.sourceWorktreeId ?? chain.worktreeId)
              : chain.worktreeId
          const source = await waitForSourceSessionCompletion(
            withResolveRetry(
              createTerminalWaitDependencies(
                workspaceRuntimeTarget(worktreeId),
                { sourcePaneKey, worktreeId },
                local.signal
              ),
              local.signal
            ),
            local.signal
          )
          return { handle: source.handle, exited: false }
        } catch (error) {
          local.abort()
          // Why: a plan parks on the pane that asked, so the row can say which one needs the person.
          if (error instanceof SourceSessionBlockedError) {
            error.paneKey = sourcePaneKey
          }
          throw error
        }
      })
    )
  } finally {
    signal.removeEventListener('abort', stopLocal)
  }
}
