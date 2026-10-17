/** @vitest-environment happy-dom */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { mountOnRealStore, resetRealStore, type RealStoreMount } from '@/test/mount-on-real-store'
import { RunsOnDispatch } from './RunsOnDispatch'

/**
 * Why this test exists: the dispatch door selects the destination WORKSPACE from the store while a
 * placement is chosen. For a folder-workspace session that object is rebuilt on every read, so
 * hovering or choosing a computer used to die with React #185. The port from the deleted
 * `AddNextPanels.react185.test.tsx` has to mount on the REAL store and use the REAL MenuTargets —
 * a mocked `@/store` or a stubbed MenuTargets cannot arm the selector at all.
 */
const session = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'folder:w1',
  hostId: 'local' as const,
  tabId: 'tab',
  paneKey: 'pane',
  kind: 'terminal' as const,
  label: 'Build',
  workspaceLabel: 'Docs',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

let mounted: RealStoreMount | null = null

beforeEach(() => {
  localStorage.clear()
  resetRealStore()
  useAppStore.setState({
    folderWorkspaces: [
      {
        id: 'w1',
        projectGroupId: 'project',
        name: 'Docs',
        folderPath: '/docs',
        executionHostId: 'local',
        isArchived: false
      }
    ]
  } as never)
})

afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  resetRealStore()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('Runs on, mounted on the real store', () => {
  it('survives choosing a computer for a folder-workspace session', async () => {
    mounted = await mountOnRealStore(
      <RunsOnDispatch session={session as never} onSent={() => {}} />,
      { windowApi: 'pending', settle: 40 }
    )
    // Why: "…best available machine…" in the fleet section also matches a loose /mac/i, so the
    // own-computer row is named exactly.
    const host = [...mounted.container.querySelectorAll('[role="menuitem"]')].find((item) =>
      /^This (Mac|computer)/.test(item.textContent ?? '')
    ) as HTMLButtonElement | undefined
    expect(host).toBeTruthy()
    await act(async () => {
      host!.click()
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    // Why: a fresh-object selector throws on the next store write, not on the click.
    await act(async () => {
      useAppStore.setState({ activeWorktreeId: null })
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    // Why: the door is still standing — and it is the folded one, with its own run buttons.
    expect(mounted.container.textContent).toContain('Just run it')
    expect(mounted.container.textContent).not.toContain(/Who gets this next/)
  })
})
