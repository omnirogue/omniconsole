import { describe, expect, it } from 'vitest'
import {
  conversationOrganizationFor,
  sessionArchiveKind
} from './session-manage-conversation-organization'
import { emptySessionSidebarView, type SessionSidebarView } from './session-sidebar-view'

const ID = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'
const key = (hostId: string, id: string, worktreeId = 'repo::/w') =>
  JSON.stringify([hostId, 'provider', `${worktreeId}\0claude\0session_id\0${id}`])

function view(overrides: Partial<SessionSidebarView>): SessionSidebarView {
  return { ...emptySessionSidebarView(), ...overrides }
}

describe('sessionArchiveKind', () => {
  it('tells an automatic filing from an archive by hand', () => {
    const filed = view({ autoArchiveLog: [{ key: 'a', proof: 'p', at: 1 }] })
    expect(sessionArchiveKind(filed, ['a', 'b'], 'a')).toBe('automatic')
    expect(sessionArchiveKind(filed, ['a', 'b'], 'b')).toBe('manual')
    expect(sessionArchiveKind(filed, ['b'], 'a')).toBeNull()
    const restored = view({ autoArchiveLog: [{ key: 'a', proof: 'p', at: 1, restoredAt: 2 }] })
    expect(sessionArchiveKind(restored, ['a'], 'a')).toBe('manual')
  })
})

describe('conversationOrganizationFor', () => {
  it('reads a closed conversation from its view keys on the same host', () => {
    const own = key('local', ID)
    const filed = view({
      archived: [own],
      autoArchiveLog: [{ key: own, proof: 'p', at: 1 }],
      deleted: [key('local', 'other')],
      hidden: [`conversation:${key('runtime:env-1', ID)}`]
    })
    expect(conversationOrganizationFor(filed, [own], { hostId: 'local', sessionId: ID })).toEqual({
      deleted: false,
      hidden: false,
      archiveKind: 'automatic'
    })
    expect(
      conversationOrganizationFor(filed, [own], { hostId: 'runtime:env-1', sessionId: ID })
    ).toEqual({
      deleted: false,
      hidden: true,
      archiveKind: null,
      hiddenKeys: [key('runtime:env-1', ID)]
    })
    expect(
      conversationOrganizationFor(filed, [own], { hostId: 'local', sessionId: 'other' })
    ).toEqual({
      deleted: true,
      hidden: false,
      archiveKind: null,
      deletedKeys: [key('local', 'other')]
    })
  })

  it('names every view key that deletes it, across workspaces', () => {
    const one = key('local', ID, 'repo::/a')
    const two = key('local', ID, 'repo::/b')
    const filed = view({ deleted: [one, key('local', 'other'), two] })
    expect(
      conversationOrganizationFor(filed, [], { hostId: 'local', sessionId: ID }).deletedKeys
    ).toEqual([one, two])
  })
})
