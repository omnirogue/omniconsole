// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { RuntimeBrowserClientPlacement } from '../../../../../shared/runtime-browser-placement'

// Every per-page retention term reaches the guest as a prop on BrowserPagePane, where a wrong value
// parks the webview display:none. The threading itself had no coverage: a mutant hardcoding any of
// the three to false left the whole suite green.
type MockAppState = {
  browserPagesByWorkspace: Record<string, BrowserPage[]>
  remoteBrowserPageHandlesByPageId: Record<
    string,
    { environmentId: string; placement: RuntimeBrowserClientPlacement }
  >
  updateBrowserPageState: () => void
  setBrowserPageUrl: () => void
}

const mocks = vi.hoisted(() => ({
  state: null as MockAppState | null,
  runtimeEnvironmentId: null as string | null,
  clientProps: [] as { id: string; isActive: boolean; isAutomationVisible: boolean }[],
  pageProps: [] as {
    id: string
    isAutomationVisible: boolean
    isMobileDriven: boolean
    isRemotelyViewed: boolean
  }[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockAppState) => unknown) => {
    if (!mocks.state) {
      throw new Error('mock app state not initialized')
    }
    return selector(mocks.state)
  }
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => mocks.runtimeEnvironmentId
}))

vi.mock('../ClientHostedBrowserPagePane', () => ({
  ClientHostedBrowserPagePane: (props: {
    browserTab: BrowserPage
    isActive: boolean
    isAutomationVisible: boolean
  }) => {
    mocks.clientProps.push({
      id: props.browserTab.id,
      isActive: props.isActive,
      isAutomationVisible: props.isAutomationVisible
    })
    return <span data-client-page-id={props.browserTab.id} />
  }
}))

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))

vi.mock('../host-guest/webview-registry', () => ({
  destroyPersistentWebview: () => {}
}))

vi.mock('./ssh-routed-browser-page-gate', () => ({
  SshRoutedBrowserPageGate: ({
    children
  }: {
    children: (routedPartition: string | null) => React.ReactNode
  }) => <>{children(null)}</>
}))

vi.mock('./BrowserMobileDriverOverlay', () => ({
  BrowserMobileDriverOverlay: () => null
}))

vi.mock('./browser-page-pane', () => ({
  BrowserPagePane: (props: {
    browserTab: BrowserPage
    isAutomationVisible: boolean
    isMobileDriven: boolean
    isRemotelyViewed: boolean
  }) => {
    mocks.pageProps.push({
      id: props.browserTab.id,
      isAutomationVisible: props.isAutomationVisible,
      isMobileDriven: props.isMobileDriven,
      isRemotelyViewed: props.isRemotelyViewed
    })
    return <span data-browser-page-id={props.browserTab.id} />
  }
}))

import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility
} from '../host-guest/browser-automation-visibility'
import { hydrateBrowserDrivers } from '@/lib/pane-manager/browser-mobile-driver-state'
import { hydrateBrowserRemoteViewerPages } from '@/lib/pane-manager/browser-remote-viewer-state'
import BrowserPane from './browser-workspace-pane'

const WORKSPACE_ID = 'ws-1'

function createPage(id: string): BrowserPage {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    worktreeId: 'wt-1',
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  } as unknown as BrowserPage
}

function createWorkspace(): BrowserWorkspace {
  return {
    id: WORKSPACE_ID,
    worktreeId: 'wt-1',
    label: 'browser',
    sessionProfileId: null,
    activePageId: 'page-a',
    pageIds: ['page-a', 'page-b'],
    url: 'about:blank',
    title: 'browser',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  } as unknown as BrowserWorkspace
}

function propsFor(pageId: string): (typeof mocks.pageProps)[number] {
  const props = mocks.pageProps.findLast((entry) => entry.id === pageId)
  if (!props) {
    throw new Error(`BrowserPagePane never rendered for ${pageId}`)
  }
  return props
}

function renderWorkspacePane(): void {
  mocks.pageProps = []
  render(<BrowserPane browserTab={createWorkspace()} isActive={true} />)
}

describe('browser workspace pane retention props', () => {
  beforeEach(() => {
    mocks.runtimeEnvironmentId = null
    mocks.clientProps = []
    mocks.state = {
      browserPagesByWorkspace: { [WORKSPACE_ID]: [createPage('page-a'), createPage('page-b')] },
      remoteBrowserPageHandlesByPageId: {},
      updateBrowserPageState: () => {},
      setBrowserPageUrl: () => {}
    }
    hydrateBrowserDrivers([])
    hydrateBrowserRemoteViewerPages([])
  })

  afterEach(() => {
    cleanup()
    hydrateBrowserDrivers([])
    hydrateBrowserRemoteViewerPages([])
  })

  it('threads all three retention terms to the page that owns them', () => {
    renderWorkspacePane()
    expect(propsFor('page-b')).toEqual({
      id: 'page-b',
      isAutomationVisible: false,
      isMobileDriven: false,
      isRemotelyViewed: false
    })

    cleanup()
    const token = acquireBrowserAutomationVisibility('page-b')
    hydrateBrowserDrivers([
      { browserPageId: 'page-b', driver: { kind: 'mobile', clientId: 'phone-1' } }
    ])
    hydrateBrowserRemoteViewerPages(['page-b'])
    renderWorkspacePane()

    expect(propsFor('page-b')).toEqual({
      id: 'page-b',
      isAutomationVisible: true,
      isMobileDriven: true,
      isRemotelyViewed: true
    })
    // Why the sibling: each term must land on the page it belongs to, not on every page of the tab.
    expect(propsFor('page-a')).toEqual({
      id: 'page-a',
      isAutomationVisible: false,
      isMobileDriven: false,
      isRemotelyViewed: false
    })
    releaseBrowserAutomationVisibility(token)
  })

  it('mounts a leased client sibling once and preserves it when the user selects it', () => {
    mocks.runtimeEnvironmentId = 'environment-a'
    mocks.state!.browserPagesByWorkspace[WORKSPACE_ID]!.push(createPage('page-c'))
    for (const id of ['page-a', 'page-b', 'page-c']) {
      mocks.state!.remoteBrowserPageHandlesByPageId[id] = {
        environmentId: 'environment-a',
        placement: {
          kind: 'client',
          browserHostClientId: 'client-a',
          browserHostGeneration: 2,
          pageHostGeneration: 3
        }
      }
    }
    const first = acquireBrowserAutomationVisibility('page-b')
    const second = acquireBrowserAutomationVisibility('page-b')
    try {
      const view = render(<BrowserPane browserTab={createWorkspace()} isActive />)
      const original = view.container.querySelector('[data-client-page-id="page-b"]')
      expect(original).not.toBeNull()
      expect(view.container.querySelectorAll('[data-client-page-id="page-b"]')).toHaveLength(1)
      expect(view.container.querySelector('[data-client-page-id="page-c"]')).toBeNull()
      expect(mocks.clientProps.findLast((props) => props.id === 'page-a')).toMatchObject({
        isActive: true,
        isAutomationVisible: false
      })
      expect(mocks.clientProps.findLast((props) => props.id === 'page-b')).toMatchObject({
        isActive: false,
        isAutomationVisible: true
      })
      view.rerender(
        <BrowserPane browserTab={{ ...createWorkspace(), activePageId: 'page-b' }} isActive />
      )
      act(() => {
        releaseBrowserAutomationVisibility(first)
        releaseBrowserAutomationVisibility(second)
      })
      expect(view.container.querySelector('[data-client-page-id="page-b"]')).toBe(original)
      expect(mocks.clientProps.findLast((props) => props.id === 'page-b')).toMatchObject({
        isActive: true,
        isAutomationVisible: false
      })
    } finally {
      releaseBrowserAutomationVisibility(first)
      releaseBrowserAutomationVisibility(second)
    }
  })
})
