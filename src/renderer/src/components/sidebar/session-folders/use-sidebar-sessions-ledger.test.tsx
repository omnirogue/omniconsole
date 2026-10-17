// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionProjectRows } from '@/components/projects/use-session-project-rows'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import {
  ledgerBucket,
  ledgerRecord,
  ledgerSlices,
  pairedSource
} from '@/lib/mirrored-conversation-test-fixtures'
import type { RuntimeSessionConversationRecord } from '../../../../../shared/session-conversation-ledger'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSidebarSessions } from './use-sidebar-sessions'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const FOLDER = '00000000-0000-4000-8000-00000000000a'
const initialState = useAppStore.getInitialState()

/** One ledger event: the owner's whole bucket for the workspace, as step 5 applies it. */
function ledgerEvent(records: RuntimeSessionConversationRecord[]): void {
  act(() => {
    useAppStore.setState(ledgerSlices([ledgerBucket(records)]))
  })
}

describe('the sidebar hooks read the owner ledger (addendum C2)', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    const { repos, worktreesByRepo } = pairedSource()
    useAppStore.setState({ repos, worktreesByRepo })
    useSessionSidebarView.setState({
      view: emptySessionSidebarView(),
      archived: [],
      loaded: true,
      showHidden: false
    })
    useSessionFolders.setState({
      metadata: { version: 1, folders: [{ id: FOLDER, name: 'Ads' }], membership: {} },
      loaded: true,
      error: null
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('re-renders sidebar and project rows when only a ledger event changes them', () => {
    const { result } = renderHook(() => ({
      sessions: useSidebarSessions(),
      project: useSessionProjectRows()
    }))
    expect(result.current.sessions).toEqual([])

    // Membership: the owner lists a slept conversation this computer has no tab or record of.
    ledgerEvent([ledgerRecord('s1')])
    expect(result.current.sessions.map((row) => row.label)).toEqual(['Owner s1'])
    expect(result.current.sessions[0]?.mirroredConversation?.rest).toBe('asleep')
    expect(result.current.project.rows.map((row) => row.session.label)).toEqual(['Owner s1'])

    // Rest.
    ledgerEvent([ledgerRecord('s1', { rest: 'dormant' })])
    expect(result.current.sessions[0]?.mirroredConversation?.rest).toBe('dormant')

    // Archive, then placement: the project rows follow the owner too.
    ledgerEvent([ledgerRecord('s1', { rest: 'dormant', archived: { archived: true } })])
    expect(result.current.sessions[0]?.ownerArchive?.archived).toBe(true)
    expect(result.current.project.rows[0]?.archived).toBe(true)
    ledgerEvent([ledgerRecord('s1', { archived: { archived: false }, folderId: FOLDER })])
    expect(result.current.sessions[0]?.ownerArchive?.archived).toBe(false)
    expect(result.current.project.rows[0]).toMatchObject({ archived: false, folderId: FOLDER })

    // The owner deletes it: its tombstone empties the bucket and the row leaves.
    ledgerEvent([])
    expect(result.current.sessions).toEqual([])
    expect(result.current.project.rows).toEqual([])
  })
})
