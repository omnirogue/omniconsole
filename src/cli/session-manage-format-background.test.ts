import { describe, expect, it } from 'vitest'
import { formatSessionList } from './session-manage-format'
import type { SessionManageEntry } from '../shared/session-manage-types'

const entry = {
  paneKey: 'tab-orphan:leaf-9',
  tabId: 'tab-orphan',
  terminal: 'term_orphan',
  title: 'claude conversation',
  agent: 'claude',
  kind: 'terminal',
  worktreeId: 'repo::/ads',
  worktreePath: '/ads',
  workspace: '/ads',
  hostId: 'local',
  folder: null,
  saved: false,
  archived: false,
  pinned: false,
  verdict: 'live',
  state: 'idle',
  stateBasis: 'hook',
  agentForeground: true,
  lastActivityAt: null,
  waitingOn: null,
  pendingSteps: [],
  queueLength: 0,
  keepGoing: false,
  placement: 'background-not-in-window'
} satisfies SessionManageEntry

// Why (C3 step 5): a process an earlier remote click started must read as running in the
// background, with the existing commands that open or end it, never as an ordinary sidebar row.
describe('session list background terminals', () => {
  it('says where a background terminal runs and how to open or end it', () => {
    const text = formatSessionList({
      sessions: [entry],
      scope: { source: 'controller-sidebar', backgroundTerminals: 'listed', includeArchived: false }
    })

    expect(text).toContain(
      '  running in the background, not in a window — open it: omni session show --pane tab-orphan:leaf-9; end it: omni terminal close --terminal term_orphan'
    )
    expect(text).toContain('Runtime-owned terminals no window shows are listed')
  })

  it('names the gap when the host could not check, and keeps the old note for older hosts', () => {
    const unavailable = formatSessionList({
      sessions: [],
      scope: {
        source: 'controller-sidebar',
        backgroundTerminals: 'unavailable',
        includeArchived: false
      }
    })
    const older = formatSessionList({
      sessions: [],
      scope: { source: 'controller-sidebar', includeArchived: false }
    })

    expect(unavailable).toContain('Background terminals could not be checked')
    expect(older).toContain(
      'Background terminals without a sidebar row are outside this inventory.'
    )
  })
})
