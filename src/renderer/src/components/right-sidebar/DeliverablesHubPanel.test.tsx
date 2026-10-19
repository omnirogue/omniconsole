// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DeliverablesHubPanel from './DeliverablesHubPanel'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  search: vi.fn(),
  resolve: vi.fn(),
  ensureDetectedAgents: vi.fn()
}))

const store = {
  repos: [
    {
      id: 'repo-1',
      kind: 'git',
      path: '/repo',
      displayName: 'Product',
      worktreeBaseRef: 'origin/main'
    }
  ],
  ensureDetectedAgents: mocks.ensureDetectedAgents
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: typeof store) => unknown) => selector(store), {
    getState: () => store
  })
}))
vi.mock('@/lib/launch-work-item-direct', () => ({ launchWorkItemDirect: mocks.launch }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
  localStorage.setItem('deliverables-hub-repo-id', 'repo-1')
  mocks.search.mockResolvedValue({
    root: '/Work/Ops/Plans',
    total: 1,
    skipped: 0,
    entries: [
      {
        relativePath: 'wave/W19-19.md',
        title: 'Deliverables Hub Spec',
        taskId: 'W19-19',
        modifiedAt: 123,
        excerpt: 'Build the panel.'
      }
    ]
  })
  mocks.resolve.mockResolvedValue('/Work/Ops/Plans/wave/W19-19.md')
  mocks.ensureDetectedAgents.mockResolvedValue(['codex'])
  mocks.launch.mockResolvedValue(true)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      deliverablesHub: { search: mocks.search, resolve: mocks.resolve },
      shell: { openPath: vi.fn() }
    }
  })
})

afterEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('Deliverables Hub panel', () => {
  it('launches the selected local repo with the validated plan path', async () => {
    render(<DeliverablesHubPanel />)
    expect(await screen.findByText('Deliverables Hub Spec')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Launch Code Builder in Worktree' }))
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
    expect(mocks.resolve).toHaveBeenCalledWith('wave/W19-19.md', 123)
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo-1',
        baseBranch: 'origin/main',
        agentOverride: 'codex',
        promptDelivery: 'submit-after-ready',
        item: expect.objectContaining({
          pasteContent: expect.stringContaining('/Work/Ops/Plans/wave/W19-19.md')
        })
      })
    )
  })
})
