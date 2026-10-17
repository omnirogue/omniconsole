// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { migrateLegacyStorageKeys } from './legacy-storage-key-migration'

function storage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed))
  const api = {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    }
  } as Storage
  // Object.keys() over a Storage reads its own enumerable keys, which is what the migration walks.
  return new Proxy(api, {
    ownKeys: () => [...map.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
  })
}

describe('carrying preferences across the rename', () => {
  it('copies a legacy key to its new name', () => {
    const store = storage({ 'orca.linear.issue-view.v1': '{"mode":"list"}' })

    const result = migrateLegacyStorageKeys(store)

    expect(store.getItem('omni.linear.issue-view.v1')).toBe('{"mode":"list"}')
    expect(result.migrated).toEqual(['orca.linear.issue-view.v1'])
  })

  it('leaves the legacy key in place, so a rollback still finds its own state', () => {
    const store = storage({ 'orca.githubProject.hiddenColumns': '["Done"]' })

    migrateLegacyStorageKeys(store)

    expect(store.getItem('orca.githubProject.hiddenColumns')).toBe('["Done"]')
  })

  it('never overwrites a preference already set on the new build', () => {
    const store = storage({
      'orca.browserUse.enabled': 'true',
      'omni.browserUse.enabled': 'false'
    })

    const result = migrateLegacyStorageKeys(store)

    expect(store.getItem('omni.browserUse.enabled')).toBe('false')
    expect(result.skipped).toEqual(['orca.browserUse.enabled'])
  })

  it('treats an empty string as a value, not as absent', () => {
    const store = storage({
      'orca.terminalShortcutCapturedNotice.': 'seen',
      'omni.terminalShortcutCapturedNotice.': ''
    })

    migrateLegacyStorageKeys(store)

    expect(store.getItem('omni.terminalShortcutCapturedNotice.')).toBe('')
  })

  it('ignores keys that are not ours', () => {
    const store = storage({ 'orcashark.theme': 'dark', 'vendor.orca.thing': '1' })

    const result = migrateLegacyStorageKeys(store)

    expect(result.migrated).toEqual([])
    expect(store.getItem('omni.shark.theme')).toBeNull()
  })

  it('is idempotent across launches', () => {
    const store = storage({ 'orca.featureWall.completedWorkflows.v1': '["workspaces"]' })

    migrateLegacyStorageKeys(store)
    store.setItem('omni.featureWall.completedWorkflows.v1', '["workspaces","agents"]')
    const second = migrateLegacyStorageKeys(store)

    expect(store.getItem('omni.featureWall.completedWorkflows.v1')).toBe('["workspaces","agents"]')
    expect(second.migrated).toEqual([])
  })

  it('carries on when one key throws', () => {
    const base = storage({ 'orca.a': '1', 'orca.b': '2' })
    const hostile = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'setItem') {
          return (key: string, value: string) => {
            if (key === 'omni.a') {
              throw new DOMException('quota', 'QuotaExceededError')
            }
            return Reflect.get(target, 'setItem', receiver).call(target, key, value)
          }
        }
        return Reflect.get(target, prop, receiver)
      }
    }) as Storage

    const result = migrateLegacyStorageKeys(hostile)

    expect(result.migrated).toEqual(['orca.b'])
    expect(result.skipped).toEqual(['orca.a'])
  })

  it('does nothing, and throws nothing, without a usable storage', () => {
    expect(() => migrateLegacyStorageKeys(undefined)).not.toThrow()
  })
})
