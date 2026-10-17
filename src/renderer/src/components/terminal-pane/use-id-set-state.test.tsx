// @vitest-environment happy-dom

import { createElement, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import { afterEach, describe, expect, it } from 'vitest'
import { useIdSetState } from './use-id-set-state'

type IdSetState = ReturnType<typeof useIdSetState>

describe('useIdSetState', () => {
  const root = createRoot(document.createElement('div'))

  afterEach(() => {
    flushSync(() => root.render(null))
  })

  it('keeps the stored set for an equal one and takes a changed one', () => {
    let latest: IdSetState | null = null
    let renders = 0
    function Probe(): null {
      renders += 1
      latest = useIdSetState()
      return null
    }
    flushSync(() => root.render(createElement(Probe)))
    const read = (): IdSetState => latest as unknown as IdSetState
    const [initial, setIds] = read()

    flushSync(() => setIds(new Set()))
    expect(read()[0]).toBe(initial)
    expect(renders).toBe(1)

    const parked = new Set(['worktree-1'])
    flushSync(() => setIds(parked))
    expect(read()[0]).toBe(parked)
    flushSync(() => setIds(new Set(['worktree-1'])))
    expect(read()[0]).toBe(parked)
    expect(renders).toBe(2)
  })

  it('queues nothing when an effect re-sets an equal set after every store write', async () => {
    const useRevisionStore = create(() => ({ revision: 0 }))
    let renders = 0
    function Probe(): null {
      renders += 1
      const revision = useRevisionStore((state) => state.revision)
      const [, setIds] = useIdSetState()
      useEffect(() => {
        setIds(new Set())
      }, [revision, setIds])
      return null
    }
    flushSync(() => root.render(createElement(Probe)))

    // Why microtask yields only: restore writes land before React's Default-priority renders run.
    // A `current => same ? current : next` updater queued a render behind each of these commits
    // until React threw "Maximum update depth exceeded" (#185).
    for (let write = 1; write <= 60; write += 1) {
      useRevisionStore.setState({ revision: write })
      await Promise.resolve()
      await Promise.resolve()
    }

    expect(renders).toBe(61)
  })
})
