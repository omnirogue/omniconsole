import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useWaitLater } from '@/store/wait-later-store'
import { waitLaterKeyForPane } from '@/lib/wait-later'
import { sourcePaneKeysForStep } from '@/lib/session-chain-support'
import { waitForFinishedStops, type PlanBlockAccess } from '@/lib/session-chain-blocks'
import {
  closeSessionTab,
  sessionTabHasUnfinishedAgent,
  sessionTabIsOpen
} from '@/lib/close-session-tab'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { endsWithOwnershipHandoff } from '../../../shared/session-chain-destination'
import { isSessionChainAgentStep, type SessionChain } from '../../../shared/session-chain-types'

/** The resolve failure a closed pane produces; every other wait failure is a real failure. */
export function isPaneGoneError(error: unknown): boolean {
  return error instanceof Error && /could not be found/i.test(error.message)
}

export { endsWithOwnershipHandoff }

/** Every tab the plan's sessions live in: the one it started from, then each one it launched. */
export function planSessionTabIds(chain: SessionChain): string[] {
  const paneKeys = [
    chain.sourcePaneKey,
    ...chain.steps.filter(isSessionChainAgentStep).map((step) => step.launchedPaneKey ?? null)
  ]
  const tabIds = new Set<string>()
  for (const paneKey of paneKeys) {
    const tabId = paneKey
      ? (parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId)
      : undefined
    if (tabId) {
      tabIds.add(tabId)
    }
  }
  return [...tabIds]
}

/**
 * ✓ ended the plan and the work finished: its sessions close the way a person closes them
 * (reopenable from Recently closed). A tab where an agent is busy or asking again stays open.
 */
export async function closePlanSessions(
  chain: SessionChain
): Promise<{ closed: number; keptOpen: number }> {
  let closed = 0
  let keptOpen = 0
  for (const tabId of planSessionTabIds(chain)) {
    if (!sessionTabIsOpen(tabId)) {
      continue
    }
    if (sessionTabHasUnfinishedAgent(tabId)) {
      keptOpen += 1
      continue
    }
    if ((await closeSessionTab(tabId, { rejectPinned: true })) === false) {
      keptOpen += 1
    } else {
      closed += 1
    }
  }
  return { closed, keptOpen }
}

/**
 * What the plan's ending does to the conversation it started from. ✓ ends its sessions once
 * the work has really finished; ↩ Back to me gives it back as "needs you". Both wait for the
 * last pane to stop, and a pane asking the person parks the plan under Needs you instead.
 */
export async function finishSessionChainSource(
  chain: SessionChain,
  signal: AbortSignal,
  access: PlanBlockAccess
): Promise<void> {
  if (chain.end !== 'done' && chain.end !== 'me') {
    return
  }
  // Why: handed to a person, the conversation is complete for the requester; a mark would drag it back.
  if (endsWithOwnershipHandoff(chain)) {
    return
  }
  try {
    await waitForFinishedStops(
      access,
      chain,
      sourcePaneKeysForStep(chain, chain.steps.length),
      signal
    )
  } catch (error) {
    if (signal.aborted) {
      return
    }
    // Why: only a pane the person closed counts as finished; a non-zero exit or an unverifiable
    // host is a failed plan, never a finished one.
    if (!isPaneGoneError(error)) {
      throw error
    }
    console.warn('[session-chain] the last pane is gone; treating the plan as finished', error)
  }
  if (signal.aborted) {
    return
  }
  const key = waitLaterKeyForPane(chain.sourcePaneKey)
  if (chain.end === 'me') {
    useWaitLater.getState().setReturned(key, new Date())
    return
  }
  useWaitLater.getState().setFinished(key, new Date())
  const outcome = await closePlanSessions(access.getChain() ?? chain)
  if (outcome.closed > 0 || outcome.keptOpen > 0) {
    toast.success(
      outcome.keptOpen > 0
        ? translate(
            'nextStep.planEndedKeptOpen',
            'Finished. {{closed}} closed; {{kept}} stayed open because it is pinned or an agent there is busy.',
            { closed: outcome.closed, kept: outcome.keptOpen }
          )
        : translate(
            'nextStep.planEndedClosed',
            'Finished and closed. Reopen it from Recently closed.'
          )
    )
  }
}
