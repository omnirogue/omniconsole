// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useSessionSnoozeMigration } from './session-snooze'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { emptySessionSidebarView } from './session-sidebar-view'
import type { SidebarSession } from './sidebar-sessions'

afterEach(cleanup)

it('retires old attention deadlines while retaining hidden, archived and unfinished sessions', () => {
  const saved = {
    ...emptySessionSidebarView(),
    hidden: ['conversation:private'],
    archived: ['archived'],
    snoozedUntil: { saved: Date.now() + 90_000, unavailable: Date.now() + 120_000 }
  }
  useSessionSidebarView.setState({ loaded: true, view: saved })
  const sessions = [{ sessionKey: 'saved', paneKey: 'tab:leaf' }] as SidebarSession[]
  const before = structuredClone(sessions)
  const { rerender } = renderHook(() => useSessionSnoozeMigration(sessions))
  expect(useSessionSidebarView.getState().view).toEqual({ ...saved, snoozedUntil: {} })
  expect(sessions).toEqual(before)
  rerender()
  expect(useSessionSidebarView.getState().view).toEqual({ ...saved, snoozedUntil: {} })
})
