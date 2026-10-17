import { describe, expect, it } from 'vitest'
import { nativeChatPlanBlock, type NativeChatPlan } from '../../../../shared/native-chat-plan'
import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  nativeChatPlanEntryRows,
  selectLatestNativeChatPlan,
  summarizeNativeChatPlan
} from './native-chat-plan-checklist'

const initialPlan: NativeChatPlan = {
  entries: [
    { content: 'Inspect the launch path', status: 'completed' },
    { content: 'Repair session progress', status: 'in_progress' },
    { content: 'Check the installed app', status: 'pending' }
  ]
}

function message(id: string, blocks: NativeChatBlock[]): NativeChatMessage {
  return { id, blocks, role: 'system', source: 'transcript', timestamp: null }
}

describe('latest agent checklist', () => {
  it('keeps step keys stable across reordering and status updates, including repeated descriptions', () => {
    const before = nativeChatPlanEntryRows({
      entries: [
        { content: 'Inspect', status: 'pending' },
        { content: 'Verify', status: 'pending' },
        { content: 'Inspect', status: 'pending' }
      ]
    })
    const after = nativeChatPlanEntryRows({
      entries: [
        { content: 'Verify', status: 'in_progress' },
        { content: 'Inspect', status: 'completed' },
        { content: 'Inspect', status: 'pending' }
      ]
    })
    expect(new Set(before.map((row) => row.key)).size).toBe(3)
    expect(after.map((row) => row.key)).toEqual([before[1].key, before[0].key, before[2].key])
  })

  it('uses the newest explicit snapshot without inferring progress from prose', () => {
    const latest: NativeChatPlan = {
      entries: [{ content: 'Check the installed app', status: 'in_progress' }]
    }
    expect(
      selectLatestNativeChatPlan([
        message('earlier', [nativeChatPlanBlock(initialPlan)]),
        message('latest', [nativeChatPlanBlock(initialPlan), nativeChatPlanBlock(latest)]),
        message('prose', [{ type: 'text', text: 'Everything is complete. - [x] All done' }])
      ])
    ).toEqual(latest)
  })

  it('lets an empty snapshot clear earlier entries', () => {
    expect(
      selectLatestNativeChatPlan([
        message('earlier', [nativeChatPlanBlock(initialPlan)]),
        message('cleared', [nativeChatPlanBlock({ entries: [] })])
      ])
    ).toEqual({ entries: [] })
  })

  it('ignores malformed metadata and user-authored plans', () => {
    expect(
      selectLatestNativeChatPlan([
        message('valid', [nativeChatPlanBlock(initialPlan)]),
        message('future-format', [
          { type: 'text', text: 'Plan', plan: { entries: null } as unknown as NativeChatPlan }
        ]),
        { ...message('user', [nativeChatPlanBlock({ entries: [] })]), role: 'user' }
      ])
    ).toEqual(initialPlan)
  })

  it.each(['update_plan', 'functions.update_plan'])(
    'projects terminal %s tool calls through the same checklist',
    (name) => {
      expect(
        selectLatestNativeChatPlan([
          message('call', [
            {
              type: 'tool-call',
              name,
              input: {
                plan: [{ step: 'Read the session', status: 'in_progress' }],
                explanation: 'Checking the current launch.'
              }
            }
          ])
        ])
      ).toEqual({
        entries: [{ content: 'Read the session', status: 'in_progress' }],
        explanation: 'Checking the current launch.'
      })
    }
  )

  it('reads TodoWrite and ignores failed or unrelated tool calls', () => {
    expect(
      selectLatestNativeChatPlan([
        message('call', [
          { type: 'tool-call', name: 'TodoWrite', input: { todos: initialPlan.entries } }
        ]),
        message('failed', [
          { type: 'tool-call', name: 'TodoWrite', input: { todos: [] }, state: 'failed' }
        ]),
        message('other', [
          { type: 'tool-call', name: 'write_file', input: { todos: [], plan: [] } }
        ])
      ])
    ).toEqual(initialPlan)
  })

  it('returns no checklist when a session has no explicit plan', () => {
    expect(selectLatestNativeChatPlan([])).toBeNull()
    expect(
      selectLatestNativeChatPlan([message('text', [{ type: 'text', text: '- [ ] A suggestion' }])])
    ).toBeNull()
  })

  it('counts only reported completed entries and keeps pending distinct from current', () => {
    expect(summarizeNativeChatPlan(initialPlan)).toEqual({
      completed: 1,
      total: 3,
      current: initialPlan.entries[1],
      next: initialPlan.entries[2]
    })
    expect(
      summarizeNativeChatPlan({ entries: [{ content: 'Ready to start', status: 'pending' }] })
    ).toEqual({
      completed: 0,
      total: 1,
      current: null,
      next: { content: 'Ready to start', status: 'pending' }
    })
  })
})
