import { describe, expect, it } from 'vitest'
import type { OrganizationRecord } from '../shared/session-organization-change'
import {
  describeOrganizationChange,
  formatSessionActions,
  formatSessionHistory
} from './session-history-format'

const NOW = new Date(2026, 8, 25, 18, 0)
const local = (hours: number, minutes: number) =>
  new Date(2026, 8, 25, hours, minutes).toISOString()

const move: OrganizationRecord = {
  opId: 'move-1',
  kind: 'move',
  targets: [{ sessionKey: 'claude:abc' }],
  value: 'f-checkout',
  executor: { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Ads review' },
  reason: 'it is checkout work',
  evidence: 'touches src/checkout',
  phase: 'applied',
  ts: local(10, 12)
}

describe('formatSessionHistory', () => {
  it('prints one readable line per change: time · what · who · reason · evidence · undoable', () => {
    const rename: OrganizationRecord = {
      opId: 'title-1',
      kind: 'title',
      targets: [{ sessionKey: 'claude:abc' }],
      value: 'Checkout fixes',
      origin: 'yours',
      executor: { kind: 'person', via: 'sidebar' },
      phase: 'applied',
      ts: local(11, 3)
    }
    const text = formatSessionHistory(
      {
        key: 'claude:abc',
        row: {
          viewKey: 'claude:abc',
          title: 'Checkout fixes',
          paneKey: 'tab-1:leaf-1',
          tabId: 'tab-1'
        },
        entries: [rename, move],
        pending: [],
        ownership: {},
        revocations: { title: { at: local(11, 3), opId: 'title-1', why: 'person/sidebar' } },
        undoable: ['move-1']
      },
      new Map([['f-checkout', 'Clients / Checkout']]),
      NOW
    )
    expect(text.split('\n')).toEqual([
      'History of “Checkout fixes” (claude:abc)',
      '11:03 · Renamed to “Checkout fixes” (your words) · by you (sidebar)',
      '10:12 · Moved to Clients / Checkout · by “Ads review” (session) · reason: it is checkout work · evidence: touches src/checkout · undoable',
      'Title is yours for good (11:03): agents and sync never take it back.'
    ])
  })
})

describe('formatSessionActions', () => {
  it('prints a 100-session organize as one line and a legacy action by its summary', () => {
    const text = formatSessionActions(
      {
        actions: [
          {
            ts: local(9, 30),
            actor: { paneKey: 'tab-9:leaf-9', title: 'Steward' },
            action: 'session.move',
            target: {},
            summary: 'move: 100 targets applied',
            reason: 'keep within five',
            opId: 'organize-1',
            phase: 'applied',
            executor: { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Steward' },
            organization: {
              kind: 'move',
              targets: Array.from({ length: 100 }, (_, index) => ({ sessionKey: `s${index}` })),
              value: null
            }
          },
          {
            ts: local(8, 5),
            actor: 'cli',
            action: 'stop',
            target: { paneKey: 'tab-2:leaf-1' },
            summary: 'Stopped “Parser fix”',
            request: 'stop the parser one'
          }
        ]
      },
      new Map(),
      NOW
    )
    expect(text.split('\n')).toEqual([
      '09:30 · Moved to Unfiled (100 sessions) · by “Steward” (session) · reason: keep within five',
      '08:05 · Stopped “Parser fix” · by the omni CLI · asked: “stop the parser one”'
    ])
  })
})

describe('the steward in the trail', () => {
  it('names the Session steward for its own changes and its prompts', () => {
    const text = formatSessionActions(
      {
        actions: [
          {
            ts: local(9, 30),
            actor: 'steward',
            steward: { feature: 'rules' },
            action: 'session.archive',
            target: {},
            summary: 'archive: 1 target applied',
            reason: 'finished, not verified',
            opId: 'steward-1',
            phase: 'applied',
            executor: { kind: 'app', feature: 'steward' },
            organization: {
              kind: 'archive',
              targets: [{ sessionKey: 's1' }],
              value: true,
              evidence: 'JEV resolved 0.91 · quiet 7 h'
            }
          },
          {
            ts: local(8, 5),
            actor: 'steward',
            steward: { feature: 'rules' },
            action: 'continue',
            target: { paneKey: 'tab-2:leaf-1' },
            summary: 'Answered “Parser fix” yes to its own proposal “Add tests”'
          }
        ]
      },
      new Map(),
      NOW
    )
    const [archived, pressed] = text.split('\n')
    expect(archived).toContain(' · by the Session steward · reason: finished, not verified')
    expect(pressed).toBe(
      '08:05 · Answered “Parser fix” yes to its own proposal “Add tests” · by the Session steward'
    )
  })
})

describe('an archive that paused the agent', () => {
  it('reads in the history as the archive pausing it, by the app, with its reason', () => {
    const sleep: OrganizationRecord = {
      opId: 'sleep-1',
      kind: 'sleep',
      targets: [{ sessionKey: 'claude:abc', paneKey: 'tab-1:leaf-1', tabId: 'tab-1' }],
      value: true,
      executor: { kind: 'app', feature: 'archive-sleep' },
      reason: 'Archived, then idle and out of view for 30 minutes with nothing pending',
      phase: 'applied',
      ts: local(12, 0)
    }
    expect(describeOrganizationChange(sleep, new Map())).toBe(
      'Archive paused the agent (opening it resumes the conversation)'
    )
    const text = formatSessionHistory(
      {
        key: 'claude:abc',
        entries: [sleep],
        pending: [],
        ownership: {},
        revocations: {},
        undoable: []
      },
      new Map(),
      NOW
    )
    expect(text).toContain('Archive paused the agent')
    expect(text).toContain('by the app (archive-sleep)')
  })
})
