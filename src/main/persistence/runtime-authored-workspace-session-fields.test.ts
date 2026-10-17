import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { preserveRuntimeAuthoredWorkspaceSessionFields } from './runtime-authored-workspace-session-fields'

const row = {
  v: 1 as const,
  browserPageId: 'page-a',
  workspaceId: 'repo-1::wt-a',
  browserProfileId: 'profile-a',
  executionHostKey: 'native:runtime-a:1',
  url: 'https://kept.internal/',
  title: 'Kept',
  pairedDeviceId: 'device-a',
  savedAt: 1_800_000_000_000
}

describe('preserving runtime-authored workspace session fields', () => {
  it('carries the rows across a write that never mentions them', () => {
    // The desktop renderer builds its payload from Zustand, which has no idea the runtime
    // authority sharing this profile persists client-hosted pages.
    const next = preserveRuntimeAuthoredWorkspaceSessionFields(
      session(),
      session({ 'repo-1::wt-a': [row] })
    )

    expect(next.clientHostedBrowserPagesByWorktree).toEqual({ 'repo-1::wt-a': [row] })
  })

  it('lets the runtime clear its own rows, which it does with an empty map', () => {
    const next = preserveRuntimeAuthoredWorkspaceSessionFields(
      session({}),
      session({ 'repo-1::wt-a': [row] })
    )

    expect(next.clientHostedBrowserPagesByWorktree).toEqual({})
  })

  it('lets the runtime replace its rows outright', () => {
    const replaced = { 'repo-1::wt-b': [{ ...row, workspaceId: 'repo-1::wt-b' }] }

    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(
        session(replaced),
        session({ 'repo-1::wt-a': [row] })
      ).clientHostedBrowserPagesByWorktree
    ).toEqual(replaced)
  })

  it('treats an explicit undefined as never having mentioned the field', () => {
    // The one ambiguous input: a writer that spreads the field through as undefined is still a
    // writer that knows nothing about it, so it must inherit rather than clear.
    const next = preserveRuntimeAuthoredWorkspaceSessionFields(
      { ...session(), clientHostedBrowserPagesByWorktree: undefined },
      session({ 'repo-1::wt-a': [row] })
    )

    expect(next.clientHostedBrowserPagesByWorktree).toEqual({ 'repo-1::wt-a': [row] })
  })

  it('leaves an untouched write alone rather than inventing a field', () => {
    const next = session()

    expect(preserveRuntimeAuthoredWorkspaceSessionFields(next, session())).toBe(next)
    expect(preserveRuntimeAuthoredWorkspaceSessionFields(next, null)).toBe(next)
  })
})

function session(
  clientHostedBrowserPagesByWorktree?: WorkspaceSessionState['clientHostedBrowserPagesByWorktree']
): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...(clientHostedBrowserPagesByWorktree ? { clientHostedBrowserPagesByWorktree } : {})
  }
}

describe('owner-created sleep checkpoints', () => {
  const leaf = '00000000-0000-4000-8000-000000000001'
  const paneKey = `tab:${leaf}`
  const checkpoint = {
    paneKey,
    tabId: 'tab',
    worktreeId: 'work',
    agent: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: 'provider' },
    prompt: '',
    state: 'done' as const,
    capturedAt: 100,
    updatedAt: 100,
    ownerSleepPtyIncarnationId: 'inc-old'
  }
  const openSurface = {
    ...session(),
    tabsByWorktree: { work: [{ id: 'tab', worktreeId: 'work' } as never] },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf' as const, leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null
      }
    }
  }
  const prior = { ...openSurface, sleepingAgentSessionsByPaneKey: { [paneKey]: checkpoint } }
  it('leaves an already-owned checkpoint unchanged', () => {
    expect(preserveRuntimeAuthoredWorkspaceSessionFields(prior, prior)).toBe(prior)
  })
  it('preserves the resume locator across a stale window full save', () => {
    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(openSurface, prior)
        .sleepingAgentSessionsByPaneKey?.[paneKey]
    ).toEqual(checkpoint)
  })
  it('does not restore the checkpoint after a local user close without an SSH tombstone', () => {
    const closed = {
      ...session(),
      tabsByWorktree: { work: [] },
      sleepingAgentSessionsByPaneKey: {}
    }
    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(closed, prior).sleepingAgentSessionsByPaneKey?.[
        paneKey
      ]
    ).toBeUndefined()
  })
  it('does not restore a closed split pane while its sibling tab remains', () => {
    const closedPane = {
      ...openSurface,
      sleepingAgentSessionsByPaneKey: {},
      terminalLayoutsByTabId: {
        tab: {
          root: { type: 'leaf' as const, leafId: 'sibling' },
          activeLeafId: 'sibling',
          expandedLeafId: null
        }
      }
    }
    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(closedPane, prior)
        .sleepingAgentSessionsByPaneKey?.[paneKey]
    ).toBeUndefined()
  })
  it('retains a checkpoint when a stale writer omits its workspace or layout', () => {
    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(session(), prior)
        .sleepingAgentSessionsByPaneKey?.[paneKey]
    ).toEqual(checkpoint)
    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(
        { ...openSurface, terminalLayoutsByTabId: {} },
        prior
      ).sleepingAgentSessionsByPaneKey?.[paneKey]
    ).toEqual(checkpoint)
  })
  it('retains ownership across an equal-time old-client echo and a subsequent omission', () => {
    const echoed = { ...checkpoint, ownerSleepPtyIncarnationId: undefined }
    const first = preserveRuntimeAuthoredWorkspaceSessionFields(
      { ...openSurface, sleepingAgentSessionsByPaneKey: { [paneKey]: echoed } },
      prior
    )
    expect(first.sleepingAgentSessionsByPaneKey?.[paneKey]?.ownerSleepPtyIncarnationId).toBe(
      'inc-old'
    )
    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(openSurface, first)
        .sleepingAgentSessionsByPaneKey?.[paneKey]
    ).toEqual(checkpoint)
  })
  it('allows a new process incarnation to consume the checkpoint', () => {
    const next = { ...session(), terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-new' } }
    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(next, prior).sleepingAgentSessionsByPaneKey
    ).toBeUndefined()
  })
  it('consumes an echoed owner checkpoint after a new process incarnation binds', () => {
    const next = { ...prior, terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-new' } }
    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(next, prior).sleepingAgentSessionsByPaneKey?.[
        paneKey
      ]
    ).toBeUndefined()
  })
  it('does not replace a newer capture or rollback', () => {
    const restored = { ...checkpoint, capturedAt: 101, ownerSleepPtyIncarnationId: undefined }
    const next = { ...session(), sleepingAgentSessionsByPaneKey: { [paneKey]: restored } }
    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(next, prior).sleepingAgentSessionsByPaneKey?.[
        paneKey
      ]
    ).toEqual(restored)
  })
})
