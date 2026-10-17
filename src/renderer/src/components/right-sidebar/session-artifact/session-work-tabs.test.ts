import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import {
  availableSessionWorkTabs,
  resolveSessionWorkTab,
  sessionWorkTabLabel
} from './session-work-tabs'

const none = { pages: 0, plans: 0, files: 0, workLog: false, nextSteps: 0 }

describe('availableSessionWorkTabs', () => {
  it('draws no tab without real content', () => {
    expect(availableSessionWorkTabs(none, null)).toEqual([])
  })

  it('keeps one order for every session: omnios, Plan, Files, Work log, Next steps', () => {
    expect(
      availableSessionWorkTabs({ pages: 2, plans: 1, files: 3, workLog: true, nextSteps: 1 }, null)
    ).toEqual(['omnios', 'plan', 'files', 'work-log', 'next-steps'])
    expect(availableSessionWorkTabs({ ...none, plans: 1, workLog: true }, null)).toEqual([
      'plan',
      'work-log'
    ])
  })

  it('keeps a tab the person explicitly asked for', () => {
    expect(availableSessionWorkTabs({ ...none, workLog: true }, 'next-steps')).toEqual([
      'work-log',
      'next-steps'
    ])
  })
})

describe('resolveSessionWorkTab', () => {
  it('opens on the first tab with content, else keeps the person’s pick', () => {
    expect(resolveSessionWorkTab(['plan', 'work-log'], null)).toBe('plan')
    expect(resolveSessionWorkTab(['plan', 'work-log'], 'work-log')).toBe('work-log')
    expect(resolveSessionWorkTab(['plan', 'work-log'], 'omnios')).toBe('plan')
    expect(resolveSessionWorkTab([], 'omnios')).toBeNull()
  })

  it('labels each tab in plain words', () => {
    expect(
      ['omnios', 'plan', 'files', 'work-log'].map((tab) => sessionWorkTabLabel(tab as never))
    ).toEqual(['OmniOS', 'Plan', 'Files & links', 'Work log'])
  })
})
