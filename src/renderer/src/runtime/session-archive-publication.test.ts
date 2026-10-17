import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { buildPaneSessions } from '@/lib/sidebar-sessions'
import { conversationViewKey } from '@/lib/conversation-view'
import {
  buildMobileSessionTabSnapshots,
  setRuntimeGraphSessionArchivePublicationGetter
} from './sync-runtime-graph'
import { sessionArchivePublication } from './session-archive-publication'
import { makeState } from './sync-runtime-graph-test-harness'
import type { AppState } from '@/store'
import { sessionTestSource, addSessionTestTab } from '@/lib/sidebar-session-test-fixtures'

const initialView = useSessionSidebarView.getState()
beforeEach(() => setRuntimeGraphSessionArchivePublicationGetter(sessionArchivePublication))
afterEach(() => {
  setRuntimeGraphSessionArchivePublicationGetter(null)
  useSessionSidebarView.setState(initialView, true)
})

function ownerState() {
  const source = sessionTestSource()
  addSessionTestTab(source, 'owner-tab')
  return makeState(source)
}

function publishedArchive(state: AppState) {
  const tab = buildMobileSessionTabSnapshots(state)
    .flatMap((snapshot) => snapshot.tabs)
    .find((candidate) => candidate.type === 'terminal')
  expect(tab?.type).toBe('terminal')
  return tab?.type === 'terminal' ? tab.sessionArchive : undefined
}

describe('owner archive publication', () => {
  it('leaves archive placement unknown without a registered sidebar publisher', () => {
    setRuntimeGraphSessionArchivePublicationGetter(null)
    expect(publishedArchive(ownerState())).toBeUndefined()
  })

  it('republishes manual archive and unarchive even when the app store is unchanged', () => {
    const state = ownerState()
    const session = buildPaneSessions(state)[0]!
    expect(session.hostId).toBe('local')
    const key = conversationViewKey(session)
    useSessionSidebarView.setState({
      loaded: true,
      archiveStorageReady: true,
      archived: [],
      view: { ...initialView.view, archived: [] }
    })
    expect(publishedArchive(state)).toEqual({ archived: false, byHand: false })
    useSessionSidebarView.setState({ archived: [key] })
    expect(publishedArchive(state)).toEqual({ archived: true, byHand: true })
    useSessionSidebarView.setState({ archived: [] })
    expect(publishedArchive(state)).toEqual({ archived: false, byHand: false })
  })

  it('leaves archive placement unknown until saved archive storage is ready', () => {
    const state = ownerState()
    useSessionSidebarView.setState({ loaded: true, archiveStorageReady: false })
    expect(publishedArchive(state)).toBeUndefined()
    useSessionSidebarView.setState({
      archiveStorageReady: true,
      archived: [],
      view: { ...initialView.view, archived: [] }
    })
    expect(publishedArchive(state)).toEqual({ archived: false, byHand: false })
  })
})
