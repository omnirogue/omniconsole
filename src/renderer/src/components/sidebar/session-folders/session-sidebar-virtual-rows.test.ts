import { describe, expect, it } from 'vitest'
import type { ConversationFleetSidebarRow } from '@/lib/conversation-fleet-sidebar'
import type { SessionSidebarGroup, SessionSidebarTreeRow } from '@/lib/session-sidebar-tree'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  flattenSessionSidebarGroups,
  sessionGroupExtraRowCount,
  windowSessionSidebarGroups
} from './session-sidebar-virtual-rows'

function row(id: string): SessionSidebarTreeRow {
  return {
    session: { rowKey: id } as SidebarSession,
    folderId: null,
    attention: null,
    state: null,
    waitingUntil: null
  }
}

/** A fleet receipt as the sidebar really shapes it: the run, and its source row when known. */
function fleetRow(workflowId: string): ConversationFleetSidebarRow {
  return { run: { workflowId }, source: null } as ConversationFleetSidebarRow
}

function group(
  key: string,
  kind: SessionSidebarGroup['kind'],
  rows: SessionSidebarTreeRow[],
  collapsed = false
): SessionSidebarGroup & { fleetRows: ConversationFleetSidebarRow[] } {
  return {
    key,
    kind,
    label: key,
    rows,
    collapsed,
    hidden: false,
    attentionCount: 0,
    canReorder: false,
    canHide: false,
    fleetRows: []
  }
}

function extraIndexes(rows: readonly { kind: string; extraIndex?: number }[]): number[] {
  return rows.filter((entry) => entry.kind === 'extra').map((entry) => entry.extraIndex!)
}

function extras(groups: Parameters<typeof flattenSessionSidebarGroups>[0]) {
  return flattenSessionSidebarGroups(groups).filter((entry) => entry.kind === 'extra')
}

describe('session sidebar virtual rows', () => {
  it('flattens headers and rows, skips collapsed bodies and keeps a row listed twice distinct', () => {
    const shared = row('a')
    const rows = flattenSessionSidebarGroups([
      group('attention', 'attention', [shared]),
      group('folder:x', 'folder', [shared, row('b')]),
      group('folder:empty', 'folder', []),
      group('waiting', 'waiting', [row('c')], true)
    ])
    expect(rows.map((entry) => entry.kind)).toEqual([
      'header',
      'row',
      'header',
      'row',
      'row',
      'header',
      'header'
    ])
    expect(new Set(rows.map((entry) => entry.key)).size).toBe(rows.length)
  })

  it('builds plain-text keys that stay distinct when group and row names collide', () => {
    // Why: these keys once used a NUL separator, which made this module binary to git and
    // hid it from PR review entirely.
    const rows = flattenSessionSidebarGroups([
      group('folder:a', 'folder', [row('b:c')]),
      group('folder:a:b', 'folder', [row('c')])
    ])
    // Why no escape here: writing one into this file is how the NUL got in.
    expect(rows.every((entry) => [...entry.key].every((char) => char.charCodeAt(0) >= 32))).toBe(
      true
    )
    expect(new Set(rows.map((entry) => entry.key)).size).toBe(rows.length)
  })

  it('gives every fleet receipt its own virtual row so the window can leave the rest unmounted', () => {
    const waiting = group('waiting', 'waiting', [row('a')])
    const rows = flattenSessionSidebarGroups([
      { ...waiting, fleetRows: [fleetRow('wf-a'), fleetRow('wf-b'), fleetRow('wf-c')] }
    ])
    expect(rows.map((entry) => entry.kind)).toEqual(['header', 'row', 'extra', 'extra', 'extra'])
    expect(extraIndexes(rows)).toEqual([0, 1, 2])
    const [slice] = windowSessionSidebarGroups(rows, [3])
    expect(slice!.window.extra).toEqual([{ index: 3, extraIndex: 1, extraKey: 'wf-b' }])
  })

  it('keys a fleet receipt by its workflow, so a reorder moves its key with it', () => {
    // Why: keyed by slot, an admission that reorders receipts hands one workflow's open
    // details dialog and pause spinner to whichever run lands in that position.
    const waiting = group('waiting', 'waiting', [])
    const before = extras([{ ...waiting, fleetRows: [fleetRow('wf-a'), fleetRow('wf-b')] }])
    const after = extras([{ ...waiting, fleetRows: [fleetRow('wf-b'), fleetRow('wf-a')] }])
    expect(before.map((entry) => entry.key)).not.toEqual(after.map((entry) => entry.key))
    // The run that was second is now first, and carries the very same key it had before.
    expect(after[0]!.key).toBe(before[1]!.key)
    expect(after[1]!.key).toBe(before[0]!.key)
    expect(after.map((entry) => entry.extraKey)).toEqual(['wf-b', 'wf-a'])
  })

  it('keeps two receipts distinct even when they report the same workflow id', () => {
    const waiting = group('waiting', 'waiting', [])
    const rows = extras([{ ...waiting, fleetRows: [fleetRow('wf-a'), fleetRow('wf-a')] }])
    expect(new Set(rows.map((entry) => entry.key)).size).toBe(2)
  })

  it('slices a window into per-group parts and marks where each group ends', () => {
    const rows = flattenSessionSidebarGroups([
      group('folder:x', 'folder', [row('a'), row('b'), row('c')]),
      group('workspace:other', 'workspace', [row('d')])
    ])
    // Why: the window starts mid-group, so the first group renders without its header.
    const slices = windowSessionSidebarGroups(rows, [5, 2, 3, 4])
    expect(slices).toEqual([
      {
        groupKey: 'folder:x',
        window: {
          header: null,
          rows: [
            { index: 2, row: expect.objectContaining({ session: { rowKey: 'b' } }) },
            { index: 3, row: expect.objectContaining({ session: { rowKey: 'c' } }) }
          ],
          extra: [],
          end: 3
        }
      },
      {
        groupKey: 'workspace:other',
        window: {
          header: 4,
          rows: [{ index: 5, row: expect.objectContaining({ session: { rowKey: 'd' } }) }],
          extra: [],
          end: 5
        }
      }
    ])
  })
})

describe('routines in the flat list', () => {
  it('lists each routine after the fleet receipts, keyed by the routine, and fills an empty folder', () => {
    const folder = {
      ...group('folder:f', 'folder', []),
      fleetRows: [fleetRow('wf_1')],
      routineRows: [{ key: 'routine:local:a' }, { key: 'routine:local:b' }]
    }
    const rows = flattenSessionSidebarGroups([folder])
    expect(
      rows.map((entry) => [entry.kind, 'extraIndex' in entry ? entry.extraIndex : null])
    ).toEqual([
      ['header', null],
      ['extra', 0],
      ['extra', 1],
      ['extra', 2]
    ])
    expect(rows.filter((entry) => entry.kind === 'extra').map((entry) => entry.extraKey)).toEqual([
      'wf_1',
      'routine:routine:local:a',
      'routine:routine:local:b'
    ])
    expect(sessionGroupExtraRowCount(folder)).toBe(3)
  })
})
