// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import { EMPTY_WORK_FILTER } from './backoffice-work-labels'
import {
  resolveWorkFocus,
  useBackofficeWorkFocus,
  useBackofficeWorkSelection
} from './backoffice-work-selection'

const KEY = 'backoffice-work-selection-v2'
const LEGACY_KEY = 'backoffice-work-selection-v1'

function row(key: string, overrides: Partial<WorkRow> = {}): WorkRow {
  return {
    key,
    source: 'task',
    taskId: 'btk_1',
    title: key,
    kind: 'work',
    nextActor: { kind: 'me' },
    why: null,
    what: null,
    actionLabel: null,
    state: null,
    dueAt: null,
    updatedAt: null,
    repliesWaiting: 0,
    needsYou: true,
    waitingFor: false,
    ...overrides
  }
}

beforeEach(() => {
  localStorage.clear()
  useBackofficeWorkFocus.setState({ request: null, missing: null })
})

describe('useBackofficeWorkSelection', () => {
  it('keeps filters and current switching but opens Needs You on the next ordinary entry', () => {
    const first = renderHook(() => useBackofficeWorkSelection('scope-a'))
    act(() =>
      first.result.current.update({
        lens: 'all',
        filter: { ...EMPTY_WORK_FILTER, person: 'emp_iris' }
      })
    )
    expect(first.result.current.selection.lens).toBe('all')
    first.unmount()
    const again = renderHook(() => useBackofficeWorkSelection('scope-a'))
    expect(again.result.current.selection).toEqual({
      lens: 'needs-you',
      rowKey: null,
      filter: { person: 'emp_iris', status: 'all', project: 'all', source: 'all', query: '' }
    })
  })

  it('reads a selection saved before source and search existed with their defaults', () => {
    localStorage.setItem(
      `${KEY}:scope-a`,
      JSON.stringify({
        lens: 'all',
        rowKey: null,
        filter: { person: 'all', status: 'replied', project: 'betacorp' }
      })
    )
    const { result } = renderHook(() => useBackofficeWorkSelection('scope-a'))
    expect(result.current.selection.filter).toEqual({
      person: 'all',
      status: 'replied',
      project: 'betacorp',
      source: 'all',
      query: ''
    })
  })

  it('bounds a stored search and ignores a source or lens it does not know', () => {
    localStorage.setItem(
      `${KEY}:scope-a`,
      JSON.stringify({
        lens: 'handoffs',
        rowKey: null,
        filter: { ...EMPTY_WORK_FILTER, source: 'everything', query: 'x'.repeat(500) }
      })
    )
    const { result } = renderHook(() => useBackofficeWorkSelection('scope-a'))
    expect(result.current.selection.lens).toBe('needs-you')
    expect(result.current.selection.filter.source).toBe('all')
    expect(result.current.selection.filter.query).toBe('x'.repeat(200))
  })

  it('ignores a stored filter it does not recognise', () => {
    localStorage.setItem(
      `${KEY}:scope-a`,
      JSON.stringify({ lens: 'all', rowKey: null, filter: { person: 3, status: 'everything' } })
    )
    const { result } = renderHook(() => useBackofficeWorkSelection('scope-a'))
    expect(result.current.selection.filter).toEqual(EMPTY_WORK_FILTER)
  })

  it.each([
    ['needs-you', 'needs-you'],
    ['waiting-for', 'waiting'],
    ['all', 'all'],
    ['handoffs', 'all'],
    ['unknown', 'needs-you']
  ])('migrates a tab-era selection (%s → %s) but opens Needs You on entry', (tab, lens) => {
    localStorage.setItem(
      `${LEGACY_KEY}:scope-a`,
      JSON.stringify({ tab, rowKey: 'handoff:hth_1', filter: { person: 'emp_iris' } })
    )
    const { result } = renderHook(() => useBackofficeWorkSelection('scope-a'))
    expect(result.current.selection).toEqual({
      lens: 'needs-you',
      rowKey: null,
      filter: { ...EMPTY_WORK_FILTER, person: 'emp_iris' }
    })
    expect(localStorage.getItem(`${LEGACY_KEY}:scope-a`)).toBeNull()
    expect(JSON.parse(localStorage.getItem(`${KEY}:scope-a`) ?? '{}').lens).toBe(lens)
  })

  it('prefers the current record over a tab-era one that was not yet removed', () => {
    localStorage.setItem(`${KEY}:scope-a`, JSON.stringify({ lens: 'waiting', rowKey: null }))
    localStorage.setItem(`${LEGACY_KEY}:scope-a`, JSON.stringify({ tab: 'all', rowKey: null }))
    const { result } = renderHook(() => useBackofficeWorkSelection('scope-a'))
    expect(result.current.selection.lens).toBe('needs-you')
  })

  it("forgets other scopes' selections, old and new, when the scope changes", () => {
    localStorage.setItem(`${KEY}:scope-a`, JSON.stringify({ lens: 'all', rowKey: 'todo:btk_1' }))
    localStorage.setItem(`${KEY}:scope-b`, JSON.stringify({ lens: 'waiting', rowKey: null }))
    localStorage.setItem(`${LEGACY_KEY}:scope-c`, JSON.stringify({ tab: 'all', rowKey: null }))
    localStorage.setItem('unrelated', 'kept')
    const { rerender, result } = renderHook(({ scope }) => useBackofficeWorkSelection(scope), {
      initialProps: { scope: 'scope-a' }
    })
    expect(result.current.selection.rowKey).toBeNull()
    expect(localStorage.getItem(`${KEY}:scope-b`)).toBeNull()
    expect(localStorage.getItem(`${LEGACY_KEY}:scope-c`)).toBeNull()
    rerender({ scope: 'scope-b' })
    expect(localStorage.getItem(`${KEY}:scope-a`)).toBeNull()
    expect(localStorage.getItem('unrelated')).toBe('kept')
  })
})

describe('resolveWorkFocus', () => {
  const thread = {
    id: 'hth_1',
    board_task_id: 'btk_1',
    author_employee_id: 'emp_gamma',
    recipient_employee_id: 'emp_sal',
    title: 'hth_1',
    state: 'open' as const,
    action: null,
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-09-11T10:00:00Z',
    files: [],
    reviews: []
  }
  const rows = [
    row('handoff:hth_1', { source: 'received-handoff', thread }),
    row('todo:btk_1::task', { source: 'task' })
  ]

  it('drops a request made under another scope', () => {
    expect(
      resolveWorkFocus(
        { scope: 'scope-b', taskId: 'btk_1' },
        'scope-a',
        rows,
        false,
        EMPTY_WORK_FILTER
      )
    ).toEqual({ kind: 'drop' })
  })

  it('selects the task row under All and keeps a filter that shows it', () => {
    const filter = { ...EMPTY_WORK_FILTER, status: 'needs-you' as const }
    expect(
      resolveWorkFocus({ scope: 'scope-a', taskId: 'btk_1' }, 'scope-a', rows, false, filter)
    ).toEqual({ kind: 'select', selection: { lens: 'all', rowKey: 'todo:btk_1::task', filter } })
  })

  it('selects a row by its key or by its thread, even when the card has a task row too', () => {
    expect(
      resolveWorkFocus(
        { scope: 'scope-a', rowKey: 'handoff:hth_1' },
        'scope-a',
        rows,
        false,
        EMPTY_WORK_FILTER
      )
    ).toMatchObject({ kind: 'select', selection: { lens: 'all', rowKey: 'handoff:hth_1' } })
    expect(
      resolveWorkFocus(
        { scope: 'scope-a', threadId: 'hth_1' },
        'scope-a',
        rows,
        false,
        EMPTY_WORK_FILTER
      )
    ).toMatchObject({ kind: 'select', selection: { lens: 'all', rowKey: 'handoff:hth_1' } })
  })

  it('opens a found row on the lens the caller asked for, not on All', () => {
    // Why: the Work home advertises Needs you rows; opening one must land on that lens.
    expect(
      resolveWorkFocus(
        { scope: 'scope-a', lens: 'needs-you', rowKey: 'handoff:hth_1' },
        'scope-a',
        rows,
        false,
        EMPTY_WORK_FILTER
      )
    ).toMatchObject({ kind: 'select', selection: { lens: 'needs-you', rowKey: 'handoff:hth_1' } })
  })

  it('clears a filter that would hide the focused row', () => {
    const filter = { ...EMPTY_WORK_FILTER, project: 'betacorp' }
    expect(
      resolveWorkFocus({ scope: 'scope-a', taskId: 'btk_1' }, 'scope-a', rows, false, filter)
    ).toMatchObject({ kind: 'select', selection: { filter: EMPTY_WORK_FILTER } })
  })

  it('waits while the lists load, then names the work the lists do not hold', () => {
    const request = { scope: 'scope-a', taskId: 'btk_gone' }
    expect(resolveWorkFocus(request, 'scope-a', rows, true, EMPTY_WORK_FILTER)).toEqual({
      kind: 'wait'
    })
    expect(resolveWorkFocus(request, 'scope-a', rows, false, EMPTY_WORK_FILTER)).toEqual({
      kind: 'missing',
      selection: {},
      id: 'btk_gone'
    })
    expect(
      resolveWorkFocus(
        { scope: 'scope-a', threadId: 'hth_gone', lens: 'waiting' },
        'scope-a',
        rows,
        false,
        EMPTY_WORK_FILTER
      )
    ).toEqual({
      kind: 'missing',
      selection: { lens: 'waiting', rowKey: null },
      id: 'hth_gone'
    })
  })

  it('opens a requested lens without waiting for rows', () => {
    expect(
      resolveWorkFocus({ scope: 'scope-a', lens: 'waiting' }, 'scope-a', [], true, {
        ...EMPTY_WORK_FILTER
      })
    ).toEqual({ kind: 'select', selection: { lens: 'waiting', rowKey: null } })
  })
})

describe('useBackofficeWorkFocus', () => {
  it('clears a "not in your lists" note when a new request arrives', () => {
    useBackofficeWorkFocus.getState().settle({ scope: 'scope-a', id: 'btk_gone' })
    useBackofficeWorkFocus.getState().focus({ scope: 'scope-a', taskId: 'btk_1' })
    expect(useBackofficeWorkFocus.getState()).toMatchObject({
      request: { scope: 'scope-a', taskId: 'btk_1' },
      missing: null
    })
  })
})
