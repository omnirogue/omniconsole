import { describe, expect, it } from 'vitest'
import { navGroup } from '@/components/sidebar/sidebar-nav-groups'
import { WORK_PAGE_SECTIONS } from '@/components/work/work-page-sections'
import { PANE_CONTENT_REGISTRY, paneContentEntry } from './pane-content-registry'

describe('command-center content registry', () => {
  it('includes every Work page and home section from their authorities', () => {
    for (const view of navGroup('work').views) {
      expect(paneContentEntry(`page:${view}`)).toBeDefined()
    }
    for (const section of WORK_PAGE_SECTIONS) {
      expect(paneContentEntry(`section:${section.id}`)).toMatchObject({ label: section.label })
    }
    expect(new Set(PANE_CONTENT_REGISTRY.map((entry) => entry.id)).size).toBe(
      PANE_CONTENT_REGISTRY.length
    )
  })
  it.each([
    'section:happening',
    'section:needs-you',
    'section:dispatch',
    'section:projects',
    'section:stats',
    'section:companies',
    'page:project',
    'page:tasks',
    'page:kanban',
    'page:companies',
    'notepad',
    'ready',
    'omnios-decisions',
    'session-statistics',
    'overview',
    'artifacts'
  ])('embeds the existing simple view %s', (id) => {
    expect(paneContentEntry(id)?.mount).toBe('embedded')
    expect(paneContentEntry(id)?.subscriptions.length).toBeGreaterThan(0)
  })
  it('groups overview with session info and offers an explicit terminal chooser', () => {
    expect(paneContentEntry('overview')).toMatchObject({
      group: 'Sessions info',
      mount: 'embedded'
    })
    expect(paneContentEntry('terminal')).toMatchObject({
      group: 'Sessions',
      mount: 'chooser',
      multiple: true
    })
  })
  it('keeps unsupported Work sections and pages explicit as full-page actions', () => {
    expect(paneContentEntry('section:cleanup')).toMatchObject({
      mount: 'full-page',
      fullPage: 'work'
    })
    expect(paneContentEntry('page:calendar')).toMatchObject({
      mount: 'full-page',
      fullPage: 'calendar'
    })
  })
})
