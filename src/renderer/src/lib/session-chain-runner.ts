import { finishSessionChainSource } from '@/lib/session-chain-ending'
import { sessionChainHandoffSource } from '@/lib/session-chain-handoff-source'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { listSessionChainsFromHost, removeSessionChainOnHost } from '@/lib/session-chain-client'
import { launchSessionChainStep } from '@/lib/session-chain-launch'
import { reconcileLaunchedSessionChainStep } from '@/lib/session-chain-launch-reconciliation'
import { sessionChainErrorMessage } from '@/lib/session-chain-error'
import {
  clearSessionChainEntries,
  deleteSessionChainEntry,
  getSessionChainEntry,
  persistSessionChain,
  publishSessionChains,
  setSessionChainEntry,
  updateSessionChain
} from '@/lib/session-chain-registry'
import {
  LOCAL_CHAIN_TARGET,
  sourcePaneKeysForStep,
  waitForWorkspaceReady
} from '@/lib/session-chain-support'
import {
  reportChainFailure,
  settleChainSteps,
  unsettledChainSteps
} from '@/lib/session-chain-hub-bridge'
import { runSessionFollowUpStep } from '@/lib/session-follow-up-step'
import { waitForFinishedStops } from '@/lib/session-chain-blocks'
import { evaluateSessionReviewBoundary } from '@/lib/session-chain-review-runtime'
import type { SourceStops } from '@/lib/session-chain-waits'
import {
  isLiveSessionChain,
  sessionChainPredecessors,
  type SessionChain
} from '../../../shared/session-chain-types'
import {
  isHostWaitingFollowUp,
  shouldKeepSessionChainRecord
} from '../../../shared/session-chain-retention'

/**
 * The mechanical successor runner. A chain waits on one session, launches the next
 * step with its own actor and rendered instruction, then waits on the session it
 * launched. Nothing here decides anything: it only waits, reads, renders and starts.
 * Intent persists in the main state file; after a restart the wait resumes, and a
 * launch happens only on an explicit click unless the chain was marked automatic.
 */
export type { SessionChainRowInfo, SessionChainStepDraft } from '@/lib/session-chain-support'
export { buildCompiledSessionChain } from '@/lib/session-chain-build'
export {
  findSessionChainForRow,
  findShownSessionChainForRow,
  getSessionChain,
  useSessionChainRows
} from '@/lib/session-chain-registry'

let loadedOnce = false

async function runChain(chainId: string, launchWhenReady: boolean): Promise<void> {
  const entry = getSessionChainEntry(chainId)
  if (!entry) {
    return
  }
  entry.controller?.abort()
  const controller = new AbortController()
  entry.controller = controller
  const { signal } = controller
  let autoLaunch = launchWhenReady
  // Why: members of a fan-out share their predecessors; the wait happens once for the first member.
  let lastWait: SourceStops | null = null
  const access = {
    getChain: () => getSessionChainEntry(chainId)?.chain ?? null,
    update: (patch: Partial<SessionChain>) => updateSessionChain(chainId, patch),
    persist: persistSessionChain
  }
  try {
    for (;;) {
      const chain = access.getChain()
      if (!chain || signal.aborted) {
        return
      }
      // Outcome-bound chains are durably owned by the host executor; renderer launch would race it.
      if (chain.outcomeSet) {
        return
      }
      if (chain.currentIndex >= chain.steps.length) {
        await finishSessionChainSource(chain, signal, access)
        if (signal.aborted) {
          return
        }
        await settleChainSteps(access, unsettledChainSteps(access.getChain() ?? chain))
        const done = updateSessionChain(chainId, { state: 'done' })
        if (done) {
          await persistSessionChain(done)
        }
        return
      }
      const pendingStep = chain.steps[chain.currentIndex]
      if (
        pendingStep &&
        pendingStep.kind !== 'handoff' &&
        pendingStep.status === 'launched' &&
        pendingStep.launchedTabId &&
        !pendingStep.launchedPaneKey
      ) {
        await reconcileLaunchedSessionChainStep(access, signal)
        continue
      }
      const sourcePaneKeys = sourcePaneKeysForStep(chain, chain.currentIndex)
      if (sourcePaneKeys.length === 0) {
        throw new Error('The session this step waits on is no longer known.')
      }
      const keys = sourcePaneKeys.join('\n')
      const known = lastWait?.keys === keys ? lastWait.stops : null
      if (chain.steps[chain.currentIndex]?.kind === 'handoff') {
        // Why: a saved follow-up was authorised when saved; it waits, captures and delivers itself.
        await runSessionFollowUpStep(
          { ...access, getChain: () => sessionChainHandoffSource(access.getChain()) },
          sourcePaneKeys,
          signal,
          known?.[0]
        )
        continue
      }
      updateSessionChain(chainId, { state: 'waiting' })
      // Why: a step after a fan-out starts only once every pane of the group has finished, and
      // never while one of them is asking the person something.
      const sources = known ?? (await waitForFinishedStops(access, chain, sourcePaneKeys, signal))
      lastWait = { keys, stops: sources }
      if (signal.aborted) {
        return
      }
      // Those panes stopping is what "the step finished" means; close each step's thread so it
      // leaves the owner's Waiting For at the moment the work actually ended.
      await settleChainSteps(access, sessionChainPredecessors(chain, chain.currentIndex))
      const review = await evaluateSessionReviewBoundary({
        chain,
        paneKeys: sourcePaneKeys,
        stops: sources,
        signal
      })
      if (review.kind !== 'none') {
        const reviewed = updateSessionChain(chainId, {
          reviewLoop: review.reviewLoop,
          ...(review.kind === 'skip' ? { currentIndex: review.currentIndex } : {}),
          ...(review.kind === 'blocked' ? { state: 'ready', error: review.reason } : {})
        })
        if (reviewed) {
          await persistSessionChain(reviewed)
        }
        if (review.kind === 'blocked') {
          return
        }
        if (review.kind === 'skip') {
          lastWait = null
          continue
        }
      }
      if (!autoLaunch) {
        // Why: after a restart the person did not watch this queue form; the chain
        // waits, shows itself as ready, and starts only when they click.
        const ready = updateSessionChain(chainId, { state: 'ready' })
        if (ready) {
          await persistSessionChain(ready)
        }
        return
      }
      await launchSessionChainStep(
        access,
        sources.map((source) => source.handle),
        signal
      )
      autoLaunch = true
    }
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return
    }
    // Why: a failed chain must not leave a sibling's wait polling; Cancel later has nothing to stop.
    controller.abort()
    const message =
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.SessionSidebar.startFailed',
            'The queued session could not start.'
          )
    const failed = updateSessionChain(chainId, { state: 'failed', error: message })
    if (failed) {
      await persistSessionChain(failed)
    }
    // Why: a failed chain used to caption its row and nothing more. Replying on each open step
    // thread is what moves the broken work into the owner's Needs You.
    await reportChainFailure(access, message)
    toast.error(sessionChainErrorMessage(message))
  } finally {
    const current = getSessionChainEntry(chainId)
    if (current?.controller === controller) {
      current.controller = null
    }
    publishSessionChains()
  }
}

export function cancelSessionChain(chainId: string): void {
  const entry = getSessionChainEntry(chainId)
  if (!entry) {
    return
  }
  entry.controller?.abort()
  entry.controller = null
  deleteSessionChainEntry(chainId)
  publishSessionChains()
  void removeSessionChainOnHost(LOCAL_CHAIN_TARGET, chainId).catch((error) =>
    console.error('[session-chain] failed to remove chain', error)
  )
}

/** Explicit start of a chain that came back from a restart and is waiting for a click. */
export function startReadySessionChain(chainId: string): void {
  const entry = getSessionChainEntry(chainId)
  if (!entry || entry.chain.state !== 'ready') {
    return
  }
  void runChain(chainId, true)
}

/** Start or restart a chain's run now; a saved follow-up always continues on its own. */
export function runSessionChainNow(chainId: string): void {
  void runChain(chainId, true)
}

/** Stop a chain's current run without touching its record. */
export function stopSessionChainRun(chainId: string): void {
  const entry = getSessionChainEntry(chainId)
  entry?.controller?.abort()
  if (entry) {
    entry.controller = null
  }
}

/**
 * Load persisted chains after the workspace session is restored. Waiting chains
 * resume their wait; automatic chains continue on their own, the others surface as
 * ready and require a click. Finished queue chains are pruned from the state file;
 * follow-ups keep their record for Waiting For. Runs once per app session.
 */
export async function loadSessionChains(): Promise<void> {
  if (loadedOnce) {
    return
  }
  loadedOnce = true
  await waitForWorkspaceReady()
  let chains: SessionChain[]
  try {
    chains = await listSessionChainsFromHost(LOCAL_CHAIN_TARGET)
  } catch (error) {
    console.error('[session-chain] failed to load chains', error)
    return
  }
  const now = Date.now()
  for (const chain of chains) {
    if (
      !chain.outcomeSet &&
      !isLiveSessionChain(chain) &&
      !shouldKeepSessionChainRecord(chain, now)
    ) {
      // Empty completed queues can expire; launched panes retain their artifact provenance.
      void removeSessionChainOnHost(LOCAL_CHAIN_TARGET, chain.id).catch((error) =>
        console.error('[session-chain] failed to prune chain', error)
      )
      continue
    }
    if (getSessionChainEntry(chain.id, LOCAL_CHAIN_TARGET)) {
      continue
    }
    setSessionChainEntry(chain)
    if (chain.state === 'waiting' || isHostWaitingFollowUp(chain)) {
      void runChain(chain.id, chain.auto)
    }
  }
  publishSessionChains()
}

/** Test seam: forget every chain without touching the host. */
export function resetSessionChainsForTests(): void {
  clearSessionChainEntries()
  loadedOnce = false
  publishSessionChains()
}
