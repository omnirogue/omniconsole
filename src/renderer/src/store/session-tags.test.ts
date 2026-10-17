import { beforeEach, describe, expect, it, vi } from 'vitest'
const scope = vi.hoisted(() => ({ key: 'alice' }))
vi.mock('@/lib/personal-view-storage', () => ({ personalViewStorageKey: () => scope.key }))
vi.mock('@/i18n/i18n', () => ({ translate: (_: string, fallback: string) => fallback }))
import { createSessionTagsStore } from './session-tags'
beforeEach(() => {
  scope.key = 'alice'
})
describe('personal session tag storage', () => {
  function storage() {
    const values = new Map<string, string>()
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      }
    }
  }
  it('persists assignments and filters through a restart', () => {
    const backing = storage()
    const first = createSessionTagsStore(() => backing)
    first.getState().load()
    expect(
      first
        .getState()
        .save({ ...first.getState().data, assignments: { session: ['acme'] }, filter: ['acme'] })
    ).toBe(true)
    const second = createSessionTagsStore(() => backing)
    second.getState().load()
    expect(second.getState().data).toMatchObject({
      assignments: { session: ['acme'] },
      filter: ['acme']
    })
  })
  it('refuses a stale write after account switch and loads the new account', () => {
    const backing = storage()
    const store = createSessionTagsStore(() => backing)
    store.getState().load()
    const edited = { ...store.getState().data, filter: ['acme'] }
    scope.key = 'bob'
    expect(store.getState().save(edited)).toBe(false)
    expect(backing.values.size).toBe(0)
    expect(store.getState().data.filter).toEqual([])
  })
  it('keeps failed writes out of visible state and refuses corrupt saved data', () => {
    const backing = storage()
    const store = createSessionTagsStore(() => ({
      ...backing,
      setItem: () => {
        throw new Error('quota')
      }
    }))
    store.getState().load()
    expect(store.getState().save({ ...store.getState().data, filter: ['acme'] })).toBe(false)
    expect(store.getState().data.filter).toEqual([])
    backing.values.set('alice', '{bad')
    store.getState().load()
    expect(store.getState().loaded).toBe(false)
    expect(store.getState().error).toBeTruthy()
  })
})
