import { sleepUnlessAborted } from '@/lib/session-chain-support'
import { waitForAllStops } from '@/lib/session-chain-waits'
import type { SourceStop } from '@/lib/session-follow-up-step'
import { useAppStore } from '@/store'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import type { SessionChain, SessionChainBlock } from '../../../shared/session-chain-types'

/** How often a plan parked on a prompt only the screen shows looks again. */
const SCREEN_BLOCK_RECHECK_MS = 5_000
/** A second look still waiting after this long means that prompt was answered. */
const SCREEN_BLOCK_CLEARED_AFTER_MS = 3_000
/** A silent hook stream can go stale without any store update; look again this often. */
const STATUS_RECHECK_MS = 30_000

export type PlanBlockAccess = {
  getChain: () => SessionChain | null
  update: (patch: Partial<SessionChain>) => SessionChain | null
}

type Statuses = Readonly<Record<string, AgentStatusEntry | undefined>>

/**
 * The first pane asking the person: a question or an approval its agent reported, or a turn
 * the person interrupted. Only the agent's own report counts; silence is never a block.
 */
export function paneBlock(
  paneKeys: readonly string[],
  statuses: Statuses
): SessionChainBlock | null {
  for (const paneKey of paneKeys) {
    const status = statuses[paneKey]
    if (status?.state === 'waiting' || status?.state === 'blocked') {
      return { paneKey, reason: status.state }
    }
    if (status?.state === 'done' && status.interrupted === true) {
      return { paneKey, reason: 'interrupted' }
    }
  }
  return null
}

/** True while a pane's agent reports work that is still going (a silent stream goes stale). */
export function paneStillWorking(
  paneKeys: readonly string[],
  statuses: Statuses,
  now = Date.now()
): boolean {
  return paneKeys.some((paneKey) => {
    const status = statuses[paneKey]
    return (
      status?.state === 'working' &&
      status.restoredUnconfirmed !== true &&
      now - status.updatedAt <= AGENT_STATUS_STALE_AFTER_MS
    )
  })
}

function sameBlock(left: SessionChainBlock | null, right: SessionChainBlock | null): boolean {
  return left?.paneKey === right?.paneKey && left?.reason === right?.reason
}

function showBlock(access: PlanBlockAccess, block: SessionChainBlock | null): void {
  const chain = access.getChain()
  if (chain && !sameBlock(chain.blocked ?? null, block)) {
    access.update({ blocked: block })
  }
}

function statuses(): Statuses {
  return useAppStore.getState().agentStatusByPaneKey
}

/** Run `callback` whenever any agent's reported status changes. */
function onStatusChange(callback: () => void): () => void {
  let last = statuses()
  return useAppStore.subscribe(() => {
    const next = statuses()
    if (next !== last) {
      last = next
      callback()
    }
  })
}

/** The source stopped on a prompt the screen shows (see SourceSessionBlockedError). */
function screenBlockOf(error: unknown, fallbackPaneKey: string): SessionChainBlock | null {
  if (!(error instanceof Error) || error.name !== 'SourceSessionBlockedError') {
    return null
  }
  const blocked = error as Error & { reason?: unknown; paneKey?: unknown }
  return {
    paneKey: typeof blocked.paneKey === 'string' ? blocked.paneKey : fallbackPaneKey,
    reason: typeof blocked.reason === 'string' ? blocked.reason : 'prompt'
  }
}

/** Resolve once `settled` holds; re-checked on every agent status change and on a slow timer. */
function waitUntil(settled: () => boolean, signal: AbortSignal): Promise<void> {
  if (settled() || signal.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearInterval(timer)
      unsubscribe()
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const check = (): void => {
      if (settled()) {
        finish()
      }
    }
    const timer = setInterval(check, STATUS_RECHECK_MS)
    const unsubscribe = onStatusChange(check)
    signal.addEventListener('abort', finish)
  })
}

/**
 * Wait until every pane a step depends on has really finished. A pane that stops to ask the
 * person parks the plan under Needs you, and the wait carries on once it is answered — so a
 * plan never moves on, and never ends a session, while a question is open.
 */
export async function waitForFinishedStops(
  access: PlanBlockAccess,
  chain: SessionChain,
  paneKeys: readonly string[],
  signal: AbortSignal
): Promise<SourceStop[]> {
  let screenBlock: SessionChainBlock | null = null
  const show = (): void => showBlock(access, paneBlock(paneKeys, statuses()) ?? screenBlock)
  // Why: a question the agent reports mid-work must reach Needs you now, not when the wait ends.
  const unsubscribe = onStatusChange(show)
  try {
    for (;;) {
      show()
      const answered: ReturnType<typeof setTimeout> | null = screenBlock
        ? setTimeout(() => {
            screenBlock = null
            show()
          }, SCREEN_BLOCK_CLEARED_AFTER_MS)
        : null
      let stops: SourceStop[]
      try {
        stops = await waitForAllStops(chain, paneKeys, signal)
      } catch (error) {
        const block = signal.aborted ? null : screenBlockOf(error, paneKeys[0] ?? '')
        if (!block) {
          throw error
        }
        if (paneStillWorking(paneKeys, statuses())) {
          // Why: the prompt detector reads scrollback; while the agent itself reports work going on,
          // that text is history, not a question — wait for the work to stop, then look again.
          screenBlock = null
          show()
          await waitUntil(() => !paneStillWorking(paneKeys, statuses()), signal)
          continue
        }
        screenBlock = block
        show()
        await sleepUnlessAborted(SCREEN_BLOCK_RECHECK_MS, signal)
        continue
      } finally {
        if (answered) {
          clearTimeout(answered)
        }
      }
      screenBlock = null
      if (signal.aborted) {
        return stops
      }
      const unsettled = (): boolean =>
        paneBlock(paneKeys, statuses()) !== null || paneStillWorking(paneKeys, statuses())
      if (!unsettled()) {
        return stops
      }
      // Why: the screen went quiet while the agent still works or waits on an answer; a stop only
      // counts once it has settled, and then it is confirmed again from the start.
      show()
      await waitUntil(() => !unsettled(), signal)
    }
  } finally {
    unsubscribe()
    showBlock(access, null)
  }
}
