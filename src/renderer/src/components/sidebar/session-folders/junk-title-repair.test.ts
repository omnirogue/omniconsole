import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  dismissJunkTitleNotice,
  isJunkTitleNoticeDismissed,
  junkTitleExample
} from './junk-title-repair'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value)
  }
}

const repairs = [
  { tabId: 't1', previous: 'worker-task_5ad8df40da3a', next: 'Fix the PDF export' },
  { tabId: 't2', previous: ' claude conversation ', next: 'Refer and earn copy' }
]

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

describe('the notice', () => {
  it('stays dismissed on this device', () => {
    expect(isJunkTitleNoticeDismissed()).toBe(false)
    dismissJunkTitleNotice()
    expect(isJunkTitleNoticeDismissed()).toBe(true)
  })

  it('names a short example', () => {
    expect(junkTitleExample(repairs)).toBe('worker-task_…')
    expect(junkTitleExample([{ tabId: 't', previous: 'ssh-2026092', next: 'x' }])).toBe(
      'ssh-2026092'
    )
  })
})
