import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openLocalRunCanvasForWorkspace, useLocalRunNavigation } from './local-run-navigation'

const mocks = vi.hoisted(() => ({ openLocalRunsPage: vi.fn(), openTaskPage: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openLocalRunsPage: mocks.openLocalRunsPage,
      openTaskPage: mocks.openTaskPage
    })
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  useLocalRunNavigation.setState({ open: false, workspacePath: null, requestedAt: 0 })
})

describe('opening the canvas from a workspace', () => {
  it('asks for a graph on that folder and opens the Local runs page, never the Tasks page', () => {
    openLocalRunCanvasForWorkspace('/Users/me/Webinar')
    expect(useLocalRunNavigation.getState()).toMatchObject({
      open: true,
      workspacePath: '/Users/me/Webinar'
    })
    expect(mocks.openLocalRunsPage).toHaveBeenCalledOnce()
    expect(mocks.openTaskPage).not.toHaveBeenCalled()
  })
})
