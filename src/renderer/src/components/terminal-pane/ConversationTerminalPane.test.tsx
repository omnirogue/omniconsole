/** @vitest-environment happy-dom */
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi, UseBoundStore } from 'zustand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  updateConversationLaunchDraft,
  useConversationLaunchDrafts
} from '@/lib/conversation-launch-draft'
import ConversationTerminalPane from './ConversationTerminalPane'

type PaneProps = ComponentProps<typeof ConversationTerminalPane>
type PaneStore = {
  tabsByWorktree: Record<
    string,
    {
      id: string
      conversationLaunchPending?: boolean
      localWorkflow?: { preset: string; prompt: string }
    }[]
  >
}
const mocks = vi.hoisted(() => ({ mounted: vi.fn(), props: vi.fn() }))

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create<PaneStore>(() => ({ tabsByWorktree: {} })) }
})
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: vi.fn() }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  getAgentDetectionTargetKeyForWorktree: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../local-workflows/LocalWorkflowConversation', () => ({
  LocalWorkflowConversation: ({ tab }: { tab: { id: string } }) => (
    <div data-workflow-anchor={tab.id} />
  )
}))
vi.mock('./TerminalPane', async () => {
  const { useEffect } = await import('react')
  return {
    default: function MockTerminalPane(props: PaneProps) {
      mocks.props(props)
      useEffect(() => {
        mocks.mounted(props.tabId)
      }, [props.tabId])
      return <div data-mounted-terminal={props.tabId} />
    }
  }
})

const store = useAppStore as unknown as UseBoundStore<StoreApi<PaneStore>>
const mounted: { root: Root; container: HTMLDivElement }[] = []

function renderPane(overrides: Partial<PaneProps> = {}): {
  container: HTMLDivElement
  onCloseTab: ReturnType<typeof vi.fn>
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  const onCloseTab = vi.fn()
  act(() => {
    root.render(
      <ConversationTerminalPane
        tabId="draft-1"
        worktreeId="wt-1"
        cwd="/project"
        isActive
        onCloseTab={onCloseTab}
        onPtyExit={vi.fn()}
        {...overrides}
      />
    )
  })
  return { container, onCloseTab }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  store.setState({
    tabsByWorktree: { 'wt-1': [{ id: 'draft-1', conversationLaunchPending: true }] }
  })
  useConversationLaunchDrafts.setState({
    drafts: { 'draft-1': { text: '', status: 'checking' } }
  })
})

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  vi.unstubAllGlobals()
})

describe('ConversationTerminalPane', () => {
  it('restores a durable workflow anchor before draft or PTY mounting', () => {
    store.setState({
      tabsByWorktree: {
        'wt-1': [{ id: 'draft-1', localWorkflow: { preset: 'council', prompt: 'saved' } }]
      }
    })
    useConversationLaunchDrafts.setState({ drafts: {} })
    const { container } = renderPane()
    expect(container.querySelector('[data-workflow-anchor="draft-1"]')).not.toBeNull()
    expect(mocks.mounted).not.toHaveBeenCalled()
  })

  it('shows the draft by default without mounting a terminal while the pending marker exists', () => {
    const { container } = renderPane()

    expect(container.querySelector('[data-conversation-launch-draft="draft-1"]')).not.toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Checking available agents'
    )
    expect(container.querySelector('textarea')?.readOnly).toBe(false)
    expect(mocks.mounted).not.toHaveBeenCalled()
    expect(mocks.props).not.toHaveBeenCalled()
  })

  it('keeps an explicitly hidden draft from mounting either surface', () => {
    const { container } = renderPane({ isVisible: false, isActive: false })

    expect(container.childElementCount).toBe(0)
    expect(mocks.mounted).not.toHaveBeenCalled()
  })

  it('never mounts a terminal if the pending tab has no hydrated draft data', () => {
    useConversationLaunchDrafts.setState({ drafts: {} })
    const { container } = renderPane({ isVisible: true })

    expect(container.querySelector('textarea')?.value).toBe('')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'could not be restored'
    )
    expect(container.querySelector('textarea')?.readOnly).toBe(true)
    expect(mocks.mounted).not.toHaveBeenCalled()
  })

  it('stores typed text in the current draft without changing another draft', () => {
    useConversationLaunchDrafts.setState({
      drafts: {
        'draft-1': { text: '', status: 'checking' },
        'draft-2': { text: 'A different request', status: 'checking' }
      }
    })
    const { container } = renderPane()
    const textarea = container.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'Review the release\nPrepare a handoff'
      )
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(useConversationLaunchDrafts.getState().drafts['draft-1'].text).toBe(
      'Review the release\nPrepare a handoff'
    )
    expect(useConversationLaunchDrafts.getState().drafts['draft-2'].text).toBe(
      'A different request'
    )
    expect(mocks.mounted).not.toHaveBeenCalled()
  })

  it('shows an accessible error with the editable request when verification fails', () => {
    const { container } = renderPane()
    act(() =>
      updateConversationLaunchDraft('draft-1', {
        text: 'Keep my request',
        status: 'failed',
        error: 'The execution host is offline'
      })
    )

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'The execution host is offline'
    )
    expect(container.querySelector('textarea')?.value).toBe('Keep my request')
    expect(container.querySelector('textarea')?.readOnly).toBe(false)
    expect(mocks.mounted).not.toHaveBeenCalled()
  })

  it('keeps the launch status visible and locks the draft until the reservation is replaced', () => {
    const { container } = renderPane({ isVisible: true })
    act(() => updateConversationLaunchDraft('draft-1', { text: 'A request', status: 'launching' }))

    expect(container.querySelector('[role="status"]')?.textContent).toBe('Opening your agent…')
    expect(container.querySelector('textarea')?.readOnly).toBe(true)
    expect(mocks.mounted).not.toHaveBeenCalled()

    act(() => store.setState({ tabsByWorktree: { 'wt-1': [{ id: 'draft-1' }] } }))

    expect(container.querySelector('[data-conversation-launch-draft]')).toBeNull()
    expect(container.querySelector('[data-mounted-terminal="draft-1"]')).not.toBeNull()
    expect(mocks.mounted).toHaveBeenCalledTimes(1)
    expect(mocks.props).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'draft-1',
        worktreeId: 'wt-1',
        cwd: '/project',
        isVisible: true,
        isActive: true
      })
    )
  })

  it('exposes the existing tab close action while the draft is pending', () => {
    const { container, onCloseTab } = renderPane()
    const closeButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Close'
    )
    expect(closeButton).toBeDefined()
    act(() => closeButton?.click())

    expect(onCloseTab).toHaveBeenCalledTimes(1)
    expect(mocks.mounted).not.toHaveBeenCalled()
  })
})
