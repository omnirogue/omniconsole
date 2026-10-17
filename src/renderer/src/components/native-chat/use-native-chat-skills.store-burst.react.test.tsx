// @vitest-environment happy-dom

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { StoreApi, UseBoundStore } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Why a real store: the startup #185 chain needs useSyncExternalStore's Sync-lane re-renders;
// the plain-function store mock in use-native-chat-skills.react.test.tsx never schedules one.
vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'worktree-1',
      folderWorkspaces: [],
      projectGroups: [],
      projects: [],
      repos: [{ id: 'repo-1', path: '/repo', connectionId: null, executionHostId: 'local' }],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] } as Record<string, { id: string }[]>,
      unifiedTabsByWorktree: {},
      worktreesByRepo: {
        'repo-1': [{ id: 'worktree-1', repoId: 'repo-1', path: '/repo/worktree', hostId: 'local' }]
      }
    }))
  }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatSkillDiscovery: vi.fn() }))

import { useAppStore } from '../../store'
import { useNativeChatSkills } from './use-native-chat-skills'

type BurstState = { tabsByWorktree: Record<string, { id: string }[]> }
const store = useAppStore as unknown as UseBoundStore<StoreApi<BurstState>>

describe('useNativeChatSkills under a startup store-write burst', () => {
  const container = document.createElement('div')
  const root = createRoot(container)

  afterEach(() => {
    flushSync(() => root.render(null))
  })

  it('does not re-run discovery for writes that leave its context unchanged', async () => {
    let renders = 0
    function Probe(): null {
      renders += 1
      useNativeChatSkills('codex', 'tab-1', false)
      return null
    }
    flushSync(() => root.render(createElement(Probe)))
    const mounted = renders

    // Why microtask yields only: a restore lands store writes faster than React's Default-priority
    // renders run, so each Sync commit also carries the previous commit's leftover update. Before
    // the fix, the discovery effect re-ran per write and re-set its idle state, which cannot bail
    // out early right after a store-driven render, so React's nested-update counter passed 50
    // and threw "Maximum update depth exceeded" (#185).
    for (let write = 0; write < 60; write += 1) {
      store.setState((state) => ({
        tabsByWorktree: { ...state.tabsByWorktree, [`other-${write}`]: [] }
      }))
      await Promise.resolve()
      await Promise.resolve()
    }

    expect(renders - mounted).toBe(60)
  })
})
