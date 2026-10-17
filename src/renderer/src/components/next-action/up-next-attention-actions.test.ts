/**
 * Every request's action opens an EXISTING door, and the right one.
 *
 * A request is only useful if the person can get to where it is met: the agent's own
 * conversation, the Done When checklist, the composer's add bar, the account settings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpNextAttention } from '../../../../shared/up-next-types'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  openSidebarSession: vi.fn(),
  sessions: [] as { paneKey: string | null; rowKey: string }[],
  openSettingsTarget: vi.fn(),
  openSettingsPage: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/sidebar/session-folders/open-sidebar-session', () => ({
  openSidebarSession: mocks.openSidebarSession
}))
vi.mock('@/lib/sidebar-sessions', () => ({ buildSidebarSessions: () => mocks.sessions }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openSettingsTarget: mocks.openSettingsTarget,
      openSettingsPage: mocks.openSettingsPage
    })
  }
}))

import { runUpNextAttentionAction, upNextAttentionDoors } from './up-next-attention-actions'
import { useDoneWhenListStore } from './use-done-when-list'

const request = (action: UpNextAttention['action']): UpNextAttention => ({
  id: 'att_1',
  kind: 'clarification',
  ask: 'Answer the question.',
  why: 'Only you can.',
  ...(action ? { action } : {})
})

const focusComposer = vi.fn()

beforeEach(() => {
  for (const mock of [
    mocks.toastError,
    mocks.openSidebarSession,
    mocks.openSettingsTarget,
    mocks.openSettingsPage,
    focusComposer
  ]) {
    mock.mockReset()
  }
  mocks.sessions = []
  useDoneWhenListStore.setState({ openChainId: null })
})

describe('the real doors', () => {
  const context = { ownPaneKey: 'pane', chainId: 'source_1' }

  it('opens the worker’s own conversation through the sidebar’s opener', () => {
    const worker = { paneKey: 'tab-9:leaf-1', rowKey: 'worker' }
    mocks.sessions = [{ paneKey: 'pane', rowKey: 'source' }, worker]
    runUpNextAttentionAction(
      request({ kind: 'open-conversation', label: 'Answer', paneKey: 'tab-9:leaf-1' }),
      context,
      upNextAttentionDoors(focusComposer)
    )
    expect(mocks.openSidebarSession).toHaveBeenCalledWith(worker)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('falls back to the conversation the panel belongs to when the request names no pane', () => {
    const source = { paneKey: 'pane', rowKey: 'source' }
    mocks.sessions = [source]
    runUpNextAttentionAction(
      request({ kind: 'open-conversation', label: 'Answer' }),
      context,
      upNextAttentionDoors(focusComposer)
    )
    expect(mocks.openSidebarSession).toHaveBeenCalledWith(source)
  })

  it('says so for a surface with no conversation of its own, such as a card', () => {
    runUpNextAttentionAction(
      request({ kind: 'open-conversation', label: 'Answer' }),
      { ownPaneKey: null, chainId: 'source_1' },
      upNextAttentionDoors(focusComposer)
    )
    expect(mocks.openSidebarSession).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('That conversation is not open on this device.')
  })

  it('says so when that conversation is not open here, instead of doing nothing', () => {
    runUpNextAttentionAction(
      request({ kind: 'open-conversation', label: 'Answer', paneKey: 'tab-gone:leaf' }),
      context,
      upNextAttentionDoors(focusComposer)
    )
    expect(mocks.openSidebarSession).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('That conversation is not open on this device.')
  })

  it('opens the Done When checklist of THIS pursuit for a review', () => {
    runUpNextAttentionAction(
      request({ kind: 'review-outcome', label: 'Review', conditionId: 'c1' }),
      context,
      upNextAttentionDoors(focusComposer)
    )
    expect(useDoneWhenListStore.getState().openChainId).toBe('source_1')
  })

  it('focuses the composer for a decision, and opens the account for a sign-in', () => {
    runUpNextAttentionAction(
      request({ kind: 'open-up-next', label: 'Decide' }),
      context,
      upNextAttentionDoors(focusComposer)
    )
    expect(focusComposer).toHaveBeenCalledTimes(1)
    runUpNextAttentionAction(
      request({ kind: 'sign-in', label: 'Sign in' }),
      context,
      upNextAttentionDoors(focusComposer)
    )
    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({ pane: 'omni-account', repoId: null })
    expect(mocks.openSettingsPage).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a request no surface can take the person to', () => {
    runUpNextAttentionAction(request(undefined), context, upNextAttentionDoors(focusComposer))
    expect(mocks.openSidebarSession).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
