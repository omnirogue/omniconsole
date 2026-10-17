import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionGrid } from './session-grid'
import {
  SESSION_GRID_V2_STORAGE_KEY as V2,
  SESSION_GRID_V1_STORAGE_KEY as V1,
  SESSION_GRID_NOTES_STORAGE_KEY as NOTES,
  SESSION_GRID_MIRROR_STORAGE_KEY as MIRROR
} from './session-grid-persistence'
import type { SessionGridSnapshot } from '@/lib/session-grid-panes'
import { parseSessionGridSnapshot } from '@/lib/session-grid-panes'
import { emptySessionGridLayout } from '@/lib/session-grid-layout'

const scope = vi.hoisted(() => ({ owner: 'a' }))
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => `${key}:${scope.owner}`,
  readPersonalView: (storage: Storage, key: string) => storage.getItem(`${key}:${scope.owner}`)
}))
const values = new Map<string, string>()
const storage = {
  getItem: vi.fn((key: string) => values.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    values.set(key, value)
  })
}
const key = (id: string): string => `${id}:${scope.owner}`
const empty = (): SessionGridSnapshot => ({
  panes: {},
  layout: emptySessionGridLayout(),
  minimized: [],
  focusedPaneId: null,
  notes: {}
})
const session = (name: string) => ({
  kind: 'session' as const,
  worktreeId: 'wt',
  sessionKey: name,
  executionHostId: 'local',
  paneKey: name,
  tabId: name,
  label: name
})
const grid = () => useSessionGrid.getState()
function reload(on = true): void {
  grid().flushWrites()
  useSessionGrid.setState(useSessionGrid.getInitialState(), true)
  grid().load(on)
}
function seed(snapshot = empty()): void {
  values.set(key(V1), JSON.stringify(snapshot))
}

beforeEach(() => {
  grid().cancelPendingWrites()
  values.clear()
  vi.clearAllMocks()
  storage.getItem.mockImplementation((key) => values.get(key) ?? null)
  storage.setItem.mockImplementation((key, value) => {
    values.set(key, value)
  })
  scope.owner = 'a'
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', storage)
  useSessionGrid.setState(useSessionGrid.getInitialState(), true)
})
afterEach(() => {
  grid().cancelPendingWrites()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('command-center grid storage', () => {
  it('seeds only absent storage, with a versioned four-pane default', () => {
    grid().load(true)
    expect(grid().storageStatus).toBe('absent')
    expect(grid().layout.tracks.map((track) => track.length)).toEqual([2, 2])
    expect(
      grid().layout.tracks.map((track) =>
        track.map((id) => (grid().panes[id] as { viewId: string }).viewId)
      )
    ).toEqual([
      ['session-chooser', 'omnios-decisions'],
      ['ready', 'overview']
    ])
    expect(storage.setItem).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(JSON.parse(values.get(key(V2))!)).toMatchObject({
      version: 2,
      activeLayoutId: 'default'
    })
  })
  it('migrates an intentionally empty v1 without seeding and only once', () => {
    seed()
    grid().load(true)
    expect(grid().layout.tracks).toEqual([])
    grid().saveLayoutAs('Saved')
    grid().flushWrites()
    const first = values.get(key(V2))
    reload()
    grid().flushWrites()
    expect(values.get(key(V2))).toBe(first)
    expect(grid().layouts.map((entry) => entry.name)).toEqual(['Imported grid', 'Saved'])
  })
  it('dual-writes a v1-shaped grid and restores the old path when disabled', () => {
    seed()
    grid().load(true)
    grid().addPane(session('remote-safe'))
    grid().addPane({ kind: 'view', viewId: 'section:stats' })
    grid().flushWrites()
    const legacy = JSON.parse(values.get(key(V1))!)
    expect(Object.values(legacy.panes)).toEqual([
      expect.objectContaining({ sessionKey: 'remote-safe' })
    ])
    grid().load(false)
    expect(Object.values(grid().panes)).toEqual([
      expect.objectContaining({ sessionKey: 'remote-safe' })
    ])
    expect(grid().commandCenter).toBe(false)
  })
  it('keeps the disabled path synchronous and never creates v2 storage', () => {
    grid().load(false)
    grid().addPane(session('legacy'))
    expect(values.has(key(V1))).toBe(true)
    expect(values.has(key(V2))).toBe(false)
    grid().applyTemplate('Default')
    grid().saveLayoutAs('No-op')
    grid().maximizePane(Object.keys(grid().panes)[0]!)
    expect(grid().layouts).toEqual([])
    expect(grid().maximizedPaneId).toBeNull()
  })
  it('preserves every legacy pane, tray entry and note through v1 rollback and re-enabling', () => {
    const previous: SessionGridSnapshot = {
      panes: {
        session: { ...session('ssh-session'), id: 'session', executionHostId: 'ssh:owner' },
        browser: {
          id: 'browser',
          kind: 'browser',
          worktreeId: 'folder',
          browserTabId: 'tab',
          label: 'Web'
        },
        note: { id: 'note', kind: 'notepad', noteId: 'draft' }
      },
      layout: {
        orientation: 'rows',
        tracks: [['session'], ['browser']],
        trackSizes: [0.4, 0.6],
        paneSizes: [[1], [1]]
      },
      minimized: ['note'],
      focusedPaneId: 'session',
      notes: { draft: { title: 'Keep me', text: 'Unsaved work' } }
    }
    seed(previous)
    grid().load(true)
    const ready = grid().addPane({ kind: 'view', viewId: 'ready' }).paneId!
    grid().saveLayoutAs('Retained')
    grid().flushWrites()
    const document = values.get(key(V2))
    const legacy = parseSessionGridSnapshot(JSON.parse(values.get(key(V1))!))
    expect(legacy.panes).toEqual(previous.panes)
    expect(legacy.minimized).toEqual(previous.minimized)
    expect(legacy.notes).toEqual(previous.notes)
    expect(legacy.layout.orientation).toBe('rows')
    expect(legacy.layout.tracks.flat().sort()).toEqual(['browser', 'session'])

    reload(false)
    expect(grid().panes).toEqual(previous.panes)
    expect(grid().minimized).toEqual(previous.minimized)
    expect(grid().notes).toEqual(previous.notes)
    expect(values.get(key(V2))).toBe(document)
    reload(true)
    expect(grid().panes).toEqual({
      ...previous.panes,
      [ready]: { id: ready, kind: 'view', viewId: 'ready' }
    })
    expect(grid().layouts.map((entry) => entry.name)).toEqual(['Imported grid', 'Retained'])
  })
  it.each([true, false])('imports off-mode edits with an existing mirror: %s', (hasMirror) => {
    seed()
    grid().load(true)
    grid().addPane({ kind: 'notepad', noteId: 'note' })
    grid().setNote('note', { title: 'Draft', text: 'before rollback' })
    const ready = grid().addPane({ kind: 'view', viewId: 'ready' }).paneId!
    grid().saveLayoutAs('Retained')
    const savedId = grid().activeLayoutId
    grid().flushWrites()
    if (!hasMirror) {
      values.delete(key(MIRROR))
    }
    grid().load(false)
    grid().setNote('note', { title: 'Edited off', text: 'valuable edit while setting is off' })
    const added = grid().addPane(session('new-while-off')).paneId!
    grid().load(true)
    expect(grid().activeLayoutId).toBe(savedId)
    expect(grid().notes.note).toEqual({
      title: 'Edited off',
      text: 'valuable edit while setting is off'
    })
    expect(grid().panes[added]).toMatchObject({ sessionKey: 'new-while-off' })
    expect(grid().panes[ready]).toMatchObject({ viewId: 'ready' })
    expect(grid().layouts.map((entry) => entry.name)).toEqual(['Imported grid', 'Retained'])
    grid().flushWrites()
    expect(JSON.parse(values.get(key(V1))!).notes.note).toEqual(grid().notes.note)
    expect(values.get(key(MIRROR))).toBe(values.get(key(V1)))
    reload()
    expect(grid().notes.note.text).toBe('valuable edit while setting is off')
    grid().switchLayout('default')
    expect(grid().notes.note.text).toBe('valuable edit while setting is off')
    expect(grid().panes[ready]).toMatchObject({ viewId: 'ready' })
  })
  it('keeps v2 geometry when rollback changes only a note', () => {
    seed()
    grid().load(true)
    grid().addPane({ kind: 'notepad', noteId: 'note' })
    grid().addPane({ kind: 'view', viewId: 'ready' })
    grid().setLayoutSizes({ trackSizes: [0.7, 0.3], paneSizes: [[1], [1]] })
    const layout = grid().layout
    grid().flushWrites()
    grid().load(false)
    grid().setNote('note', { text: 'new draft' })
    grid().load(true)
    expect(grid().layout).toEqual(layout)
    grid().flushWrites()
    expect(JSON.parse(values.get(key(V1))!).notes.note.text).toBe('new draft')
  })
  it('keeps v2-only panes in the tray when rollback fills all eight slots', () => {
    seed()
    grid().load(true)
    const ready = grid().addPane({ kind: 'view', viewId: 'ready' }).paneId!
    grid().flushWrites()
    grid().load(false)
    for (let index = 0; index < 8; index++) {
      grid().addPane(session(`off-${index}`))
    }
    grid().load(true)
    expect(grid().layout.tracks.flat()).toHaveLength(8)
    expect(grid().layout.tracks.every((track) => track.length <= 4)).toBe(true)
    expect(grid().minimized).toContain(ready)
    expect(grid().panes[ready]).toMatchObject({ viewId: 'ready' })
    grid().flushWrites()
    reload()
    expect(grid().panes[ready]).toMatchObject({ viewId: 'ready' })
  })
  it('keeps notes belonging to other named layouts through an off-mode save', () => {
    seed()
    grid().load(true)
    const note = grid().addPane({ kind: 'notepad', noteId: 'other-layout' }).paneId!
    grid().setNote('other-layout', { text: 'keep this draft' })
    grid().saveLayoutAs('Other')
    grid().switchLayout('default')
    grid().removePane(note)
    grid().flushWrites()
    grid().load(false)
    grid().addPane(session('off-mode'))
    expect(JSON.parse(values.get(key(V1))!).notes['other-layout'].text).toBe('keep this draft')
    grid().load(true)
    expect(grid().notes['other-layout'].text).toBe('keep this draft')
  })
  it('imports rollback edits after a failed write instead of replaying the stale pending copy', () => {
    seed()
    grid().load(true)
    grid().addPane({ kind: 'notepad', noteId: 'note' })
    grid().setNote('note', { text: 'before rollback' })
    grid().flushWrites()
    grid().setNote('note', { text: 'failed pending edit' })
    storage.setItem.mockImplementation(() => {
      throw new Error('quota')
    })
    grid().load(false)
    storage.setItem.mockImplementation((id, value) => {
      values.set(id, value)
    })
    grid().setNote('note', { text: 'latest rollback edit' })
    grid().load(true)
    expect(grid().notes.note.text).toBe('latest rollback edit')
    grid().flushWrites()
    expect(JSON.parse(values.get(key(V1))!).notes.note.text).toBe('latest rollback edit')
  })
  it.each([false, true])('blocks malformed legacy notes with command center %s', (enabled) => {
    const malformed = [
      { note: { title: 'Draft', text: ['recoverable text'] } },
      { note: null },
      { note: 'recoverable text' },
      { note: { title: 123, text: 'recoverable text' } },
      { note: { title: 'Draft' } },
      ['recoverable text']
    ]
    for (const notes of malformed) {
      grid().cancelPendingWrites()
      useSessionGrid.setState(useSessionGrid.getInitialState(), true)
      values.clear()
      const raw = JSON.stringify({ ...empty(), notes })
      values.set(key(V1), raw)
      grid().load(enabled)
      expect(grid().storageStatus).toBe('corrupt')
      expect(grid().writeBlocked).toBe(true)
      grid().addPane({ kind: 'notepad', noteId: 'temporary' })
      grid().setNote('temporary', { text: 'temporary projection' })
      grid().flushWrites()
      grid().retryWrites()
      grid().flushWrites()
      expect([...values]).toEqual([[key(V1), raw]])
    }
  })
  it.each(['embedded', 'sidecar', 'legacy'] as const)(
    'preserves all original storage when %s notes are malformed beside existing v2',
    (location) => {
      seed()
      grid().load(true)
      grid().flushWrites()
      const malformed = { note: { title: 'Draft', text: ['recoverable text'] } }
      if (location === 'embedded') {
        const document = JSON.parse(values.get(key(V2))!)
        document.layouts[0].snapshot.notes = malformed
        values.set(key(V2), JSON.stringify(document))
      } else if (location === 'sidecar') {
        values.set(key(NOTES), JSON.stringify(malformed))
      } else {
        values.set(key(V1), JSON.stringify({ ...empty(), notes: malformed }))
      }
      const original = [...values]
      reload()
      expect(grid().storageStatus).toBe('corrupt')
      expect(grid().writeBlocked).toBe(true)
      grid().setNote('note', { text: 'temporary projection' })
      grid().addPane(session('temporary'))
      grid().flushWrites()
      grid().retryWrites()
      grid().flushWrites()
      expect([...values]).toEqual(original)
    }
  )
  it.each([V1, V2, NOTES])('refuses corruption introduced before a pending flush: %s', (id) => {
    seed()
    grid().load(true)
    grid().flushWrites()
    grid().setNote('temporary', { text: 'pending edit' })
    values.set(key(id), '{')
    const original = [...values]
    grid().flushWrites()
    expect(grid().storageStatus).toBe('corrupt')
    expect(grid().writeBlocked).toBe(true)
    grid().retryWrites()
    grid().flushWrites()
    expect([...values]).toEqual(original)
  })
  it('refuses corruption introduced after an off-mode load', () => {
    seed()
    grid().load(false)
    values.set(key(V1), '{')
    grid().setNote('temporary', { text: 'pending edit' })
    expect(grid().storageStatus).toBe('corrupt')
    expect(grid().writeBlocked).toBe(true)
    grid().retryWrites()
    expect(values.get(key(V1))).toBe('{')
    expect(values.has(key(V2))).toBe(false)
  })
  it('debounces layout changes and skips focus-only writes', () => {
    seed()
    grid().load(true)
    grid().flushWrites()
    storage.setItem.mockClear()
    const first = grid().addPane(session('a')).paneId!
    const second = grid().addPane(session('b')).paneId!
    grid().movePane(first, { paneId: second, zone: 'center' })
    vi.advanceTimersByTime(299)
    expect(storage.setItem).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(storage.setItem.mock.calls.filter(([id]) => id === key(V2))).toHaveLength(1)
    storage.setItem.mockClear()
    grid().focusPane(second)
    grid().focusPane(first)
    vi.advanceTimersByTime(500)
    expect(storage.setItem).not.toHaveBeenCalled()
  })
  it('stores note edits separately and shares them across saved layouts', () => {
    seed()
    grid().load(true)
    grid().addPane({ kind: 'notepad', noteId: 'note' })
    grid().saveLayoutAs('Other')
    grid().flushWrites()
    storage.setItem.mockClear()
    grid().setNote('note', { text: 'new text' })
    grid().flushWrites()
    expect(storage.setItem.mock.calls.some(([id]) => id === key(V2))).toBe(false)
    expect(JSON.parse(values.get(key(NOTES))!).note.text).toBe('new text')
    grid().switchLayout('default')
    expect(grid().notes.note.text).toBe('new text')
    reload()
    expect(grid().notes.note.text).toBe('new text')
  })
  it('preserves opaque future panes, including unplaced ones, on subsequent saves', () => {
    const snapshot = empty()
    const raw = { id: 'future', kind: 'future-chart', payload: { unknown: [1, 2, 3] }, version: 7 }
    values.set(key(V1), JSON.stringify({ ...snapshot, panes: { future: raw } }))
    grid().load(true)
    expect(grid().panes.future).toEqual({ id: 'future', kind: 'unavailable', raw })
    grid().addPane(session('new'))
    grid().flushWrites()
    const document = JSON.parse(values.get(key(V2))!)
    expect(document.layouts[0].snapshot.panes.future).toEqual(raw)
    expect(grid().minimized).toContain('future')
    reload()
    expect(grid().panes.future).toEqual({ id: 'future', kind: 'unavailable', raw })
  })
  it.each([
    '{',
    JSON.stringify({ version: 3, layouts: [] }),
    JSON.stringify({
      version: 2,
      layouts: [{ id: 'bad', name: 'Bad', snapshot: { ...empty(), panes: { lost: {} } } }],
      activeLayoutId: 'bad'
    })
  ])('never overwrites unreadable or lossy documents: %s', (raw) => {
    values.set(key(V2), raw)
    grid().load(true)
    expect(grid().writeBlocked).toBe(true)
    expect(grid().storageStatus).toBe(raw.includes('"version":3') ? 'unsupported' : 'corrupt')
    grid().addPane(session('temporary'))
    grid().saveLayoutAs('Temporary')
    grid().flushWrites()
    expect(values.get(key(V2))).toBe(raw)
    expect(values.has(key(V1))).toBe(false)
  })
  it('retains edits and exposes a failed save, then retries successfully', () => {
    seed()
    grid().load(true)
    grid().addPane(session('a'))
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    grid().flushWrites()
    expect(grid().storageStatus).toBe('unwritable')
    expect(Object.values(grid().panes)[0]).toMatchObject({ sessionKey: 'a' })
    grid().retryWrites()
    grid().flushWrites()
    expect(grid().storageStatus).toBe('healthy')
    expect(values.has(key(V2))).toBe(true)
  })
  it('retains failed owner writes across profile switches and retries the captured scope', () => {
    seed()
    let blocked = true
    storage.setItem.mockImplementation((id, value) => {
      if (blocked && id.endsWith(':a')) {
        throw new Error('quota')
      }
      values.set(id, value)
    })
    grid().load(true)
    grid().addPane(session('private-a'))
    grid().flushWrites()
    scope.owner = 'b'
    grid().load(true)
    grid().flushWrites()
    expect(values.get(`${V2}:b`)).not.toContain('private-a')
    expect(grid().storageStatus).toBe('unwritable')
    scope.owner = 'a'
    grid().load(true)
    expect(Object.values(grid().panes)[0]).toMatchObject({ sessionKey: 'private-a' })
    expect(grid().storageStatus).toBe('unwritable')
    scope.owner = 'b'
    grid().load(true)
    blocked = false
    grid().retryWrites()
    grid().flushWrites()
    expect(values.get(`${V2}:a`)).toContain('private-a')
    expect(values.get(`${V2}:b`)).not.toContain('private-a')
    expect(grid().storageStatus).toBe('healthy')
    scope.owner = 'a'
    grid().load(true)
    expect(Object.values(grid().panes)[0]).toMatchObject({ sessionKey: 'private-a' })
  })
  it('distinguishes blocked storage access and never overwrites its contents', () => {
    seed()
    storage.getItem.mockImplementationOnce(() => {
      throw new Error('blocked storage')
    })
    grid().load(true)
    expect(grid().storageStatus).toBe('unwritable')
    expect(grid().writeBlocked).toBe(true)
    grid().addPane(session('temporary'))
    grid().flushWrites()
    expect(values.has(key(V2))).toBe(false)
    expect(storage.setItem).not.toHaveBeenCalled()
  })
  it('captures the owner for pending writes and reloads on account changes', () => {
    seed()
    grid().load(true)
    grid().addPane(session('a'))
    scope.owner = 'b'
    grid().load(true)
    expect(values.get(`${V2}:a`)).toContain('"sessionKey":"a"')
    grid().flushWrites()
    expect(values.get(`${V2}:b`)).not.toContain('"sessionKey":"a"')
    scope.owner = 'a'
    grid().load(true)
    expect(Object.values(grid().panes)[0]).toMatchObject({ sessionKey: 'a' })
  })
})

describe('named layout and pane continuity', () => {
  beforeEach(() => {
    seed()
    grid().load(true)
  })
  it('saves, renames, switches and deletes without changing shared session identity', () => {
    const pane = grid().addPane(session('a')).paneId!
    grid().saveLayoutAs('Two')
    const second = grid().activeLayoutId
    grid().renameLayout(second, 'Renamed')
    grid().addPane(session('b'))
    grid().switchLayout('default')
    expect(grid().panes[pane]).toMatchObject({ id: pane, sessionKey: 'a' })
    expect(grid().layout.tracks.flat()).toEqual([pane])
    grid().switchLayout(second)
    expect(grid().layout.tracks.flat()).toContain(pane)
    grid().deleteLayout(second)
    expect(grid().layouts.map((entry) => entry.name)).toEqual(['Imported grid'])
    grid().deleteLayout('default')
    expect(grid().layouts).toHaveLength(1)
  })
  it.each(['Default', 'Development', 'Monitoring', 'Maximum', 'Focused'] as const)(
    'keeps live pane ids when applying %s',
    (template) => {
      const pane = grid().addPane(session('a')).paneId!
      grid().applyTemplate(template)
      expect(grid().layout.tracks.flat()).toContain(pane)
      expect(grid().panes[pane]).toMatchObject({ sessionKey: 'a' })
      expect(grid().layout.tracks.flat().length).toBeLessThanOrEqual(8)
      expect(grid().layout.tracks.every((track) => track.length <= 4)).toBe(true)
    }
  )
  it('maximizes only the view, restores exact sizes and never saves maximize or focus', () => {
    const first = grid().addPane(session('a')).paneId!
    grid().addPane(session('b'))
    grid().setLayoutSizes({ trackSizes: [0.65, 0.35], paneSizes: [[1], [1]] })
    grid().flushWrites()
    storage.setItem.mockClear()
    const layout = grid().layout
    grid().maximizePane(first)
    expect(grid().maximizedPaneId).toBe(first)
    expect(grid().layout).toBe(layout)
    grid().maximizePane(null)
    expect(grid().layout).toBe(layout)
    vi.advanceTimersByTime(500)
    expect(storage.setItem).not.toHaveBeenCalled()
  })
  it('restores the grid when another session is activated, without saving focus or sizes', () => {
    const first = grid().addPane(session('a')).paneId!
    const second = grid().addPane(session('b')).paneId!
    grid().flushWrites()
    storage.setItem.mockClear()
    const layout = grid().layout
    grid().maximizePane(first)
    grid().focusPane(second)
    expect(grid().maximizedPaneId).toBeNull()
    expect(grid().focusedPaneId).toBe(second)
    expect(grid().layout).toBe(layout)
    vi.advanceTimersByTime(500)
    expect(storage.setItem).not.toHaveBeenCalled()
  })
  it('keeps ready and opaque draft panes past the sixteen-item tray cap', () => {
    const ready = grid().addPane({ kind: 'view', viewId: 'ready' }).paneId!
    grid().minimizePane(ready)
    const future = grid().addPane({
      kind: 'unavailable',
      raw: { kind: 'ready', draft: 'unfinished' }
    }).paneId!
    grid().minimizePane(future)
    for (let index = 0; index < 20; index++) {
      const id = grid().addPane(session(String(index))).paneId!
      grid().minimizePane(id)
    }
    expect(grid().minimized).toHaveLength(18)
    expect(grid().panes[ready]).toMatchObject({ viewId: 'ready' })
    expect(grid().panes[future]).toMatchObject({ raw: { draft: 'unfinished' } })
  })
  it('focuses a singleton view instead of creating a second copy', () => {
    const first = grid().addPane({ kind: 'view', viewId: 'section:stats' })
    expect(grid().addPane({ kind: 'view', viewId: 'section:stats' })).toEqual({
      status: 'shown',
      paneId: first.paneId
    })
  })
  it('toggles orientation without changing pane ids or sizes', () => {
    grid().addPane(session('a'))
    grid().addPane(session('b'))
    const before = grid().layout
    grid().toggleOrientation()
    expect(grid().layout).toEqual({ ...before, orientation: 'rows' })
    grid().toggleOrientation()
    expect(grid().layout).toEqual(before)
  })
})
