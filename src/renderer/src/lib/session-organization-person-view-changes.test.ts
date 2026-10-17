import { describe, expect, it, vi } from 'vitest'
import { createSessionTagsStore } from '@/store/session-tags'
import { createWaitLaterStore } from '@/store/wait-later-store'
import {
  hideSessionsByPerson,
  snoozeSessionsByPerson,
  tagSessionsByPerson
} from './session-organization-person-changes'
import {
  createOrganizationTestStores,
  fakeOrganizationRpc
} from './session-organization-test-fixture'
import { emptyWaitLater } from './wait-later'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const NOW = new Date(Date.UTC(2026, 8, 25, 12))
const WAKE = Date.UTC(2099, 0, 5, 9)

function setup() {
  const backing = new Map<string, string>()
  const tags = createSessionTagsStore(() => ({
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => void backing.set(key, value)
  }))
  const waitLater = createWaitLaterStore({ load: () => emptyWaitLater(), save: vi.fn() }, () => NOW)
  tags.getState().load()
  waitLater.getState().load()
  const stores = { ...createOrganizationTestStores(), tags, waitLater }
  const { rpc, calls } = fakeOrganizationRpc()
  let next = 0
  const deps = { stores, rpc, onRecordFailure: vi.fn(), mintOpId: () => `op-${++next}` }
  return { stores, calls, options: { deps } }
}

const settled = async () => new Promise((resolve) => setTimeout(resolve, 0))

const applied = (kind: string, value: unknown, before: unknown[], after: unknown[], op = 1) => ({
  method: 'sessionOrganization.settle',
  params: {
    phase: 'applied',
    change: {
      opId: `op-${op}`,
      kind,
      targets: [{ sessionKey: 'a' }, { sessionKey: 'b' }],
      value,
      executor: { kind: 'person', via: 'sidebar' }
    },
    before,
    after
  }
})

describe('a person’s tag, hide and snooze from the sidebar', () => {
  it('hides and shows a selection as one applied record each', async () => {
    const { stores, calls, options } = setup()
    expect(hideSessionsByPerson(['a', 'b'], true, options)).toBe(true)
    expect(stores.view.getState().view.hidden).toEqual(['conversation:a', 'conversation:b'])
    expect(hideSessionsByPerson(['a', 'b'], false, options)).toBe(true)
    expect(stores.view.getState().view.hidden).toEqual([])
    await settled()
    expect(calls).toEqual([
      applied('hide', true, [false, false], [true, true]),
      applied('unhide', false, [true, true], [false, false], 2)
    ])
  })

  it('tags a selection as one record, keeping the company tag a row showed on its own', async () => {
    const { stores, calls, options } = setup()
    expect(
      tagSessionsByPerson(['a', 'b'], 'betacorp', true, {
        ...options,
        automaticTag: (key) => (key === 'a' ? 'omnirogue' : null)
      })
    ).toBe(true)
    expect(stores.tags.getState().data.assignments).toEqual({
      a: ['omnirogue', 'betacorp'],
      b: ['betacorp']
    })
    expect(tagSessionsByPerson(['a', 'b'], 'betacorp', false, options)).toBe(true)
    expect(stores.tags.getState().data.assignments).toEqual({ a: ['omnirogue'], b: [] })
    await settled()
    expect(calls).toEqual([
      applied('tag', 'betacorp', [false, false], [true, true]),
      applied('untag', 'betacorp', [true, true], [false, false], 2)
    ])
  })

  it('snoozes and brings back a selection as one record each', async () => {
    const { stores, calls, options } = setup()
    expect(snoozeSessionsByPerson(['a', 'b'], WAKE, options)).toBe(true)
    expect(Object.keys(stores.waitLater.getState().view.until)).toEqual([
      'conversation:a',
      'conversation:b'
    ])
    expect(snoozeSessionsByPerson(['a', 'b'], null, options)).toBe(true)
    expect(stores.waitLater.getState().view.until).toEqual({})
    await settled()
    expect(calls).toEqual([
      applied('snooze', WAKE, [null, null], [WAKE, WAKE]),
      applied('snooze', null, [WAKE, WAKE], [null, null], 2)
    ])
  })
})
