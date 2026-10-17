import { useMemo } from 'react'
import { sessionHostedReviewLookup } from '@/lib/session-project-hosted-review'
import {
  sessionProjectThreadOutputsLookup,
  type SessionProjectOutputsState
} from '@/lib/session-project-thread-outputs'
import { useAppStore } from '@/store'

/** The caches a thread's review chip and Ready for review read, re-read when any of them change. */
function useSessionProjectOutputsState(): SessionProjectOutputsState {
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const repos = useAppStore((state) => state.repos)
  const hostedReviewCache = useAppStore((state) => state.hostedReviewCache)
  const prCache = useAppStore((state) => state.prCache)
  const settings = useAppStore((state) => state.settings)
  return useMemo(
    () => ({ worktreesByRepo, repos, hostedReviewCache, prCache, settings }),
    [worktreesByRepo, repos, hostedReviewCache, prCache, settings]
  )
}

export function useSessionHostedReviewOpen(): ReturnType<typeof sessionHostedReviewLookup> {
  const state = useSessionProjectOutputsState()
  return useMemo(() => sessionHostedReviewLookup(state), [state])
}

export function useSessionProjectOutputs(): ReturnType<typeof sessionProjectThreadOutputsLookup> {
  const state = useSessionProjectOutputsState()
  return useMemo(() => sessionProjectThreadOutputsLookup(state), [state])
}
