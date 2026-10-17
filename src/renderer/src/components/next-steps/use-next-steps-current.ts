import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationSource } from '../../../../shared/conversation-source'
import type { NextStepSuggestionSet } from '../../../../shared/next-step-suggestions'
import type { NextStepsCurrentResult } from '../../../../shared/next-step-suggestions-rpc'
import { readCurrentNextSteps } from './next-steps-client'
import { nextStepsDocumentVisible, startNextStepsPoll } from './next-steps-poll'

export type NextStepsCurrentController = {
  /** The host's current turn, with any set this client just answered applied on top. */
  current: NextStepsCurrentResult | null
  /** A read succeeded for this conversation; a failed read never counts. */
  loaded: boolean
  /** The last read failed; the previous answer, if any, is kept but not trusted for offers. */
  error: string | null
  /** A set a decide/offer/generate answer returned; shown at once, the next read confirms it. */
  upsert: (set: NextStepSuggestionSet) => void
  refresh: () => void
}

type Answer = { key: string; current: NextStepsCurrentResult | null; error: string | null }
type Override = { set: NextStepSuggestionSet; generation: number }

/**
 * One conversation's current turn, polled while `active`. Each read carries a generation, so an
 * older answer never overwrites a newer one, and an unchanged revision does not re-render.
 */
export function useNextStepsCurrent(
  conversation: ConversationSource | null,
  active: boolean
): NextStepsCurrentController {
  const key = conversation ? JSON.stringify(conversation) : null
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [overrides, setOverrides] = useState<{ key: string | null; byId: Map<string, Override> }>(
    () => ({ key, byId: new Map() })
  )
  const issued = useRef(0)
  const readRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    if (!key || !active) {
      readRef.current = () => undefined
      return
    }
    const addressed = JSON.parse(key) as ConversationSource
    let cancelled = false
    let applied = 0
    let revision: number | null = null
    const read = (): void => {
      if (!nextStepsDocumentVisible()) {
        return
      }
      const generation = ++issued.current
      Promise.resolve()
        .then(() => readCurrentNextSteps(addressed))
        .then(
          (result) => {
            if (cancelled || generation < applied) {
              return
            }
            applied = generation
            if (result.revision === revision) {
              setAnswer((previous) => (previous?.error ? { ...previous, error: null } : previous))
              return
            }
            revision = result.revision
            // Why here: a local answer gives way only to a newer answer from the host.
            setOverrides((current) => {
              const byId = new Map(
                [...current.byId].filter(([, entry]) => entry.generation >= generation)
              )
              return byId.size === current.byId.size ? current : { key: current.key, byId }
            })
            setAnswer({ key, current: result, error: null })
          },
          (failure: unknown) => {
            if (cancelled || generation < applied) {
              return
            }
            applied = generation
            revision = null
            const error = failure instanceof Error ? failure.message : String(failure)
            setAnswer((previous) => ({
              key,
              current: previous?.key === key ? previous.current : null,
              error
            }))
          }
        )
    }
    readRef.current = read
    const stop = startNextStepsPoll(read)
    return () => {
      cancelled = true
      readRef.current = () => undefined
      stop()
    }
  }, [key, active])

  const upsert = useCallback(
    (set: NextStepSuggestionSet) =>
      setOverrides((current) => ({
        key,
        byId: new Map(current.key === key ? current.byId : []).set(set.id, {
          set,
          generation: issued.current
        })
      })),
    [key]
  )
  const refresh = useCallback(() => readRef.current(), [])

  const own = answer?.key === key ? answer : null
  const ownCurrent = own?.current ?? null
  const current = useMemo(() => {
    const base = ownCurrent
    if (!base) {
      return null
    }
    const byId = overrides.key === key ? overrides.byId : new Map<string, Override>()
    // A set this client just got back (an offer, a manual suggest) shows before the next read.
    const swap = (
      set: NextStepSuggestionSet | undefined,
      origin: NextStepSuggestionSet['origin']
    ) =>
      set
        ? (byId.get(set.id)?.set ?? set)
        : [...byId.values()].find(
            (entry) => entry.set.origin === origin && entry.set.turnKey === base.turnKey
          )?.set
    const ai = swap(base.ai, 'ai')
    const parsed = swap(base.parsed, 'parsed')
    return { ...base, ...(ai ? { ai } : {}), ...(parsed ? { parsed } : {}) }
  }, [key, overrides, ownCurrent])
  return {
    current,
    loaded: ownCurrent !== null,
    error: own?.error ?? null,
    upsert,
    refresh
  }
}
