import { describe, expect, it } from 'vitest'
import { focusSessionSidebarGroups, groupsToFocus } from './session-group-focus'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'

const row = (key: string, needsYou = false) =>
  ({
    session: { rowKey: key, sessionKey: key },
    folderId: null,
    attention: null,
    state: null,
    returned: needsYou
  }) as unknown as SessionSidebarTreeRow

const done = (collapsed = false) => ({
  key: 'completed',
  kind: 'completed' as const,
  collapsed,
  rows: [row('a'), row('b'), row('c', true), row('d')],
  focusRows: undefined as SessionSidebarTreeRow[] | undefined
})

const keysOf = (rows: readonly SessionSidebarTreeRow[] | undefined) =>
  rows?.map((item) => item.session.rowKey)

describe('focus inside a group', () => {
  it('raises the conversation in use to the top and still lists every row', () => {
    const [group] = focusSessionSidebarGroups([done()], ['d'], new Set())
    expect(keysOf(group!.rows)).toEqual(['d', 'a', 'b', 'c'])
    expect(group!.focusRows).toBeUndefined()
  })

  it('once folded down, lists the conversation in use and what needs you', () => {
    const [group] = focusSessionSidebarGroups([done()], ['d'], new Set(['completed']))
    expect(keysOf(group!.focusRows)).toEqual(['d', 'c'])
    expect(group!.rows).toHaveLength(4)
  })

  it('leaves a group without the conversation in use, or a lone row, untouched', () => {
    const other = done()
    expect(focusSessionSidebarGroups([other], ['z'], new Set(['completed']))[0]).toBe(other)
    const lone = { ...done(), rows: [row('a')] }
    expect(focusSessionSidebarGroups([lone], ['a'], new Set(['completed']))[0]).toBe(lone)
  })

  it('never folds Needs you down to focus', () => {
    const attention = { ...done(), key: 'attention', kind: 'attention' as const }
    expect(focusSessionSidebarGroups([attention], ['d'], new Set(['attention']))[0]).toBe(attention)
  })

  it('folds down after the idle wait, and a hovered group restarts its clock', () => {
    const idleSince = new Map<string, number>()
    const tick = (now: number, hovered = false) =>
      groupsToFocus({
        groups: [done()],
        keys: ['d'],
        trimmed: new Set(),
        protectedKeys: new Set(hovered ? ['completed'] : []),
        idleSince,
        now,
        seconds: 10
      })
    expect(tick(0)).toEqual([])
    expect(tick(9_000)).toEqual([])
    expect(tick(9_500, true)).toEqual([])
    expect(tick(19_000)).toEqual([])
    expect(tick(19_500)).toEqual(['completed'])
  })

  it('does nothing when the wait is off or the group is folded', () => {
    const idleSince = new Map([['completed', 0]])
    const args = { keys: ['d'], trimmed: new Set<string>(), protectedKeys: new Set<string>() }
    expect(
      groupsToFocus({ ...args, groups: [done()], idleSince, now: 60_000, seconds: 0 })
    ).toEqual([])
    expect(idleSince.size).toBe(0)
    expect(
      groupsToFocus({ ...args, groups: [done(true)], idleSince, now: 60_000, seconds: 10 })
    ).toEqual([])
  })
})
