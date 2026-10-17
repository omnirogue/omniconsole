import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import { makeState } from './sync-runtime-graph-test-harness'
import type { AppState } from '@/store'
import { sessionTestSource, addSessionTestTab } from '@/lib/sidebar-session-test-fixtures'

function published(state: AppState) {
  const tab = buildMobileSessionTabSnapshots(state)
    .flatMap((snapshot) => snapshot.tabs)
    .find((candidate) => candidate.type === 'terminal')
  expect(tab?.type).toBe('terminal')
  return tab?.type === 'terminal' ? { title: tab.title, sessionTitle: tab.sessionTitle } : null
}

describe('owner session title publication', () => {
  it('publishes the sidebar name beside the live title, and none for an unnamed pane', () => {
    const unnamed = sessionTestSource()
    addSessionTestTab(unnamed, 'owner-tab')
    expect(published(makeState(unnamed))?.sessionTitle).toBeUndefined()

    const renamed = sessionTestSource()
    addSessionTestTab(renamed, 'owner-tab').customTitle = 'Studio name'
    expect(published(makeState(renamed))).toMatchObject({ sessionTitle: 'Studio name' })
  })
})
