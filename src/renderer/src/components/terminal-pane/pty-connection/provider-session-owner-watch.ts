import { useAppStore } from '@/store'
import {
  collectUnverifiedProviderSessionOwners,
  findLiveProviderSessionOwner,
  type ProviderSessionOwnerQuery
} from '@/lib/live-provider-session-owner'

type AppState = ReturnType<typeof useAppStore.getState>

// Why: a pane held as a duplicate has no PTY at all, and its reveal only fires when it goes from
// hidden to visible — so a pane on screen when its session's owner closes or its agent exits
// would stay blank. While held it watches the owner and decides again once the owner is gone.

function ownerSignature(state: AppState, query: ProviderSessionOwnerQuery | null): string | null {
  if (!query) {
    return 'no-target'
  }
  const owner = findLiveProviderSessionOwner(state, query)
  if (owner) {
    return `live:${owner}`
  }
  const unverified = collectUnverifiedProviderSessionOwners(state, query)
  return unverified.length > 0
    ? `probe:${unverified.map((candidate) => `${candidate.paneKey}@${candidate.ptyId}`).join(',')}`
    : null
}

/** Calls onGone (once) when no live owner remains or the probe candidates change; returns stop. */
export function watchProviderSessionOwnerUntilGone(args: {
  readQuery: (state: AppState) => ProviderSessionOwnerQuery | null
  stillHeld: () => boolean
  isDisposed: () => boolean
  isVisible: () => boolean
  onGone: () => void
}): () => void {
  let previous = ownerSignature(useAppStore.getState(), args.readQuery(useAppStore.getState()))
  let active = true
  let unsubscribe: () => void = () => {}
  const stop = (): void => {
    active = false
    unsubscribe()
  }
  unsubscribe = useAppStore.subscribe(() => {
    if (!active) {
      return
    }
    if (args.isDisposed() || !args.stillHeld()) {
      stop()
      return
    }
    const state = useAppStore.getState()
    const next = ownerSignature(state, args.readQuery(state))
    if (next === previous) {
      return
    }
    previous = next
    // Why 'no-target' waits while hidden: nothing is left to resume (the record cleared), and a
    // hidden pane must not spawn a bare shell nobody asked for; its reveal decides instead.
    if (next?.startsWith('live:') || (next === 'no-target' && !args.isVisible())) {
      return
    }
    stop()
    args.onGone()
  })
  return stop
}
