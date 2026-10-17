import { announceChainStep } from '@/lib/session-chain-hub-bridge'
import { waitForTabPaneKey } from '@/lib/session-chain-support'
import type { SessionChain, SessionChainStep } from '../../../shared/session-chain-types'

export type SessionChainLaunchAccess = {
  getChain: () => SessionChain | null
  update: (patch: Partial<SessionChain>) => SessionChain | null
  persist: (chain: SessionChain) => Promise<void>
}

function sameLaunchedStep(
  chain: SessionChain | null,
  chainId: string,
  index: number,
  tabId: string
): chain is SessionChain {
  const step = chain?.steps[index]
  return Boolean(
    chain &&
    chain.id === chainId &&
    step &&
    step.kind !== 'handoff' &&
    step.status === 'launched' &&
    step.launchedTabId === tabId &&
    !step.launchedPaneKey
  )
}

/** Finish the durable tab receipt once the renderer has materialized its pane. */
export async function reconcileLaunchedSessionChainStep(
  access: SessionChainLaunchAccess,
  signal: AbortSignal
): Promise<void> {
  const chain = access.getChain()
  if (!chain) {
    return
  }
  const index = chain.currentIndex
  const step = chain.steps[index]
  if (!step || step.kind === 'handoff' || !step.launchedTabId || step.launchedPaneKey) {
    return
  }
  const tabId = step.launchedTabId
  const launchedPaneKey = await waitForTabPaneKey(tabId, signal)
  if (signal.aborted || !sameLaunchedStep(access.getChain(), chain.id, index, tabId)) {
    return
  }
  const current = access.getChain()!
  const steps: SessionChainStep[] = current.steps.map((candidate, candidateIndex) =>
    candidateIndex === index && candidate.kind !== 'handoff'
      ? { ...candidate, launchedPaneKey }
      : candidate
  )
  const next = access.update({
    steps,
    currentIndex: index + 1,
    state:
      index + 1 >= steps.length && current.end !== 'done' && current.end !== 'me'
        ? 'done'
        : 'waiting'
  })
  if (!next) {
    return
  }
  await access.persist(next)
  const launchedStep = next.steps[index]
  if (launchedStep && launchedStep.kind !== 'handoff') {
    await announceChainStep(access, launchedStep, chain.sourceRowKey || step.agent)
  }
}
