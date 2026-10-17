// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  emptySessionProjectViewState,
  isSessionProjectViewFiltered,
  readSessionProjectViewState,
  saveSessionProjectViewState,
  sessionProjectViewFilter
} from './session-project-view-state'

const KEY = 'omni.session-project-view.v1'

beforeEach(() => {
  localStorage.clear()
})

describe('session project view state', () => {
  it('starts empty and unfiltered, and round-trips per project', () => {
    expect(readSessionProjectViewState('p1')).toEqual(emptySessionProjectViewState())
    expect(isSessionProjectViewFiltered(emptySessionProjectViewState())).toBe(false)
    const state = {
      ...emptySessionProjectViewState(),
      statuses: ['needsYou' as const],
      agents: ['codex'],
      includeArchived: true,
      search: 'checkout'
    }
    saveSessionProjectViewState('p1', state)
    expect(readSessionProjectViewState('p1')).toEqual(state)
    expect(readSessionProjectViewState('p2')).toEqual(emptySessionProjectViewState())
    expect(isSessionProjectViewFiltered(state)).toBe(true)
  })

  it('drops a damaged field but keeps the rest, and ignores garbage storage', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        p1: { statuses: ['bogus'], agents: ['codex'], search: 7, includeArchived: 'yes' }
      })
    )
    expect(readSessionProjectViewState('p1')).toEqual({
      ...emptySessionProjectViewState(),
      agents: ['codex']
    })
    localStorage.setItem(KEY, '[1,2]')
    expect(readSessionProjectViewState('p1')).toEqual(emptySessionProjectViewState())
    localStorage.setItem(KEY, '{not json')
    expect(readSessionProjectViewState('p1')).toEqual(emptySessionProjectViewState())
  })

  it('keeps the newest two hundred projects', () => {
    for (let index = 0; index < 205; index += 1) {
      saveSessionProjectViewState(`p${index}`, {
        ...emptySessionProjectViewState(),
        search: `${index}`
      })
    }
    expect(readSessionProjectViewState('p0').search).toBe('')
    expect(readSessionProjectViewState('p4').search).toBe('')
    expect(readSessionProjectViewState('p5').search).toBe('5')
    expect(readSessionProjectViewState('p204').search).toBe('204')
  })

  it('maps to the thread filter with archived and search handled by the page', () => {
    expect(
      sessionProjectViewFilter({
        ...emptySessionProjectViewState(),
        statuses: ['working'],
        hosts: ['local'],
        tasks: ['none']
      })
    ).toEqual({
      statuses: ['working'],
      agents: [],
      modelFamilies: [],
      hosts: ['local'],
      tasks: ['none'],
      includeArchived: false
    })
  })
})
