import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  isSettledSessionPullRequest,
  sessionPullRequestKey,
  type SessionPullRequestFacts,
  type SessionPullRequestRef
} from '../../../../shared/session-pull-request-facts'

// Last-known GitHub facts for session pull requests, shared by every surface that shows them.
// A conversation header reads its PRs once; an open info card keeps them fresh; rows only look.

/** A PR still moving is re-read this often while its card is open. */
export const SESSION_PULL_REQUEST_REFRESH_MS = 60_000

const known = new Map<string, SessionPullRequestFacts>()
const listeners = new Set<() => void>()
let revision = 0

function publish(facts: SessionPullRequestFacts): void {
  known.set(sessionPullRequestKey(facts), facts)
  revision += 1
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function currentRevision(): number {
  return revision
}

async function readPullRequests(refs: readonly SessionPullRequestRef[]): Promise<void> {
  const read = window.api.sessionFiles?.pullRequestFacts
  if (typeof read !== 'function') {
    return
  }
  await Promise.all(
    refs.map(async (ref) => {
      const facts = await read(ref).catch(() => null)
      if (facts) {
        publish(facts)
      }
    })
  )
}

/** `once`: read when mounted or the refs change · `poll`: and every minute until all settle. */
export type SessionPullRequestReadMode = 'off' | 'once' | 'poll'

/** Facts for these pull requests, in the given order, skipping ones not read yet. */
export function useSessionPullRequestFacts(
  refs: readonly SessionPullRequestRef[],
  mode: SessionPullRequestReadMode
): SessionPullRequestFacts[] {
  // Why a JSON key: the effect must follow the refs' content, not a new array each render.
  const refsJson = JSON.stringify(refs)
  useEffect(() => {
    const wanted = JSON.parse(refsJson) as SessionPullRequestRef[]
    if (mode === 'off' || wanted.length === 0) {
      return undefined
    }
    const moving = (): boolean =>
      wanted.some((ref) => {
        const facts = known.get(sessionPullRequestKey(ref))
        return !facts || !isSettledSessionPullRequest(facts)
      })
    void readPullRequests(wanted)
    if (mode === 'once') {
      return undefined
    }
    const timer = setInterval(() => {
      if (moving()) {
        void readPullRequests(wanted)
      }
    }, SESSION_PULL_REQUEST_REFRESH_MS)
    return () => clearInterval(timer)
  }, [refsJson, mode])
  const seen = useSyncExternalStore(subscribe, currentRevision)
  return useMemo(() => {
    void seen
    const wanted = JSON.parse(refsJson) as SessionPullRequestRef[]
    return wanted.flatMap((ref) => {
      const facts = known.get(sessionPullRequestKey(ref))
      return facts ? [facts] : []
    })
  }, [refsJson, seen])
}

/** Every pull request's last-known facts, by key; starts no read. */
export function useKnownPullRequestFacts(): ReadonlyMap<string, SessionPullRequestFacts> {
  const seen = useSyncExternalStore(subscribe, currentRevision)
  return useMemo(() => {
    void seen
    return new Map(known)
  }, [seen])
}

export function resetSessionPullRequestFactsForTest(): void {
  known.clear()
  revision = 0
}

export function publishSessionPullRequestFactsForTest(facts: SessionPullRequestFacts): void {
  publish(facts)
}
