import { describe, expect, it } from 'vitest'
import type { ConversationRoutineGroup } from '@/lib/conversation-routine-rows'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { currentSidebarRowKey, groupsToRevealForRows } from './use-current-sidebar-row'

const routineGroup = (tabId: string) =>
  ({
    routineRows: [{ key: 'routine:local:ads', automation: { conversation: { tabId } } }]
  }) as unknown as ConversationRoutineGroup

const session = (tabId: string, sessionKey: string) =>
  ({
    tabId,
    sessionKey,
    rowKey: `row-${sessionKey}`,
    worktreeId: 'wt',
    paneKey: null
  }) as unknown as SidebarSession

describe('the row on screen', () => {
  it('is the routine whose conversation is in front, not its hidden run session', () => {
    expect(
      currentSidebarRowKey([routineGroup('tab-ads')], [session('tab-ads', 'run')], {
        worktreeId: 'wt',
        tabId: 'tab-ads'
      })
    ).toBe('routine:local:ads')
  })

  it('is the conversation when no routine owns the tab', () => {
    expect(
      currentSidebarRowKey([routineGroup('tab-ads')], [session('tab-chat', 'chat')], {
        worktreeId: 'wt',
        tabId: 'tab-chat'
      })
    ).toBe('chat')
  })

  it('is nothing when no conversation is in front', () => {
    expect(
      currentSidebarRowKey([routineGroup('tab-ads')], [], { worktreeId: 'wt', tabId: null })
    ).toBeNull()
  })
})

const statusGroup = (key: string, sessionKeys: string[]) =>
  ({
    key,
    rows: sessionKeys.map((sessionKey) => ({ session: session(`tab-${sessionKey}`, sessionKey) })),
    routineRows: []
  }) as unknown as ConversationRoutineGroup

describe('revealing the rows on screen', () => {
  const metadata = emptySessionFolderMetadata()
  // Active was folded by the idle timer while the person worked in Done.
  const view = { ...emptySessionSidebarView(), collapsed: ['workspace:other', 'completed:open'] }

  it('opens the folded Active group when a prompt moves the open conversation into it', () => {
    const before = groupsToRevealForRows({
      currentKeys: ['chat'],
      groups: [statusGroup('completed', ['chat']), statusGroup('workspace:other', ['other'])],
      metadata,
      view,
      revealed: new Map()
    })
    const after = groupsToRevealForRows({
      currentKeys: ['chat'],
      groups: [statusGroup('completed', []), statusGroup('workspace:other', ['other', 'chat'])],
      metadata,
      view,
      revealed: before.revealed
    })
    expect(after.expand).toEqual(['workspace:other'])
  })

  it('leaves a group folded by hand alone while the row stays where it is', () => {
    const groups = [statusGroup('workspace:other', ['chat'])]
    const first = groupsToRevealForRows({
      currentKeys: ['chat'],
      groups,
      metadata,
      view: emptySessionSidebarView(),
      revealed: new Map()
    })
    const folded = groupsToRevealForRows({
      currentKeys: ['chat'],
      groups,
      metadata,
      view,
      revealed: first.revealed
    })
    expect(folded.expand).toEqual([])
  })

  it('opens the groups of every conversation on screen, as in a grid of three', () => {
    const result = groupsToRevealForRows({
      currentKeys: ['a', 'b', 'c'],
      groups: [statusGroup('workspace:other', ['a', 'b']), statusGroup('completed', ['c'])],
      metadata,
      // Active folded by hand; Done starts folded.
      view: { ...emptySessionSidebarView(), collapsed: ['workspace:other'] },
      revealed: new Map()
    })
    expect(result.expand.sort()).toEqual(['completed', 'workspace:other'])
  })

  it('waits for a just-launched conversation to be listed before revealing it', () => {
    const unlisted = groupsToRevealForRows({
      currentKeys: ['new'],
      groups: [statusGroup('workspace:other', [])],
      metadata,
      view,
      revealed: new Map()
    })
    expect(unlisted.expand).toEqual([])
    const listed = groupsToRevealForRows({
      currentKeys: ['new'],
      groups: [statusGroup('workspace:other', ['new'])],
      metadata,
      view,
      revealed: unlisted.revealed
    })
    expect(listed.expand).toEqual(['workspace:other'])
  })
})
