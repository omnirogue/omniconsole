import { describe, expect, it } from 'vitest'
import {
  nativeChatPlanBlock,
  readCodexNativeChatPlan,
  readNativeChatPlan,
  readNativeChatToolPlan
} from './native-chat-plan'
import { isAdmissibleAgentJournalItemBody } from './agent-session-journal-schemas'

describe('provider-authored conversation plans', () => {
  it('normalizes Codex notifications and terminal plan calls to the same checklist', () => {
    const input = {
      explanation: 'Keep the existing owner while repairing the session.',
      plan: [
        { step: 'Inspect the current session', status: 'completed' },
        { step: 'Repair the terminal view', status: 'inProgress' },
        { step: 'Verify the visible result', status: 'pending' }
      ]
    }
    const expected = {
      explanation: input.explanation,
      entries: [
        { content: 'Inspect the current session', status: 'completed' },
        { content: 'Repair the terminal view', status: 'in_progress' },
        { content: 'Verify the visible result', status: 'pending' }
      ]
    }
    expect(readCodexNativeChatPlan(input)).toEqual(expected)
    expect(readNativeChatToolPlan('functions.update_plan', input)).toEqual(expected)
    expect(readNativeChatToolPlan('update_plan', input)).toEqual(expected)
  })

  it('uses Claude todo records without treating arbitrary tools or prose as progress', () => {
    const todos = [
      { content: 'Review changes', activeForm: 'Reviewing changes', status: 'pending' }
    ]
    expect(readNativeChatToolPlan('TodoWrite', { todos })).toEqual({
      entries: [{ content: 'Review changes', status: 'pending' }]
    })
    expect(readNativeChatToolPlan('exec_command', { todos })).toBeNull()
    expect(readNativeChatPlan('All tasks completed')).toBeNull()
  })

  it('distinguishes an empty replacement from a malformed or unknown-status snapshot', () => {
    expect(readNativeChatPlan({ entries: [] })).toEqual({ entries: [] })
    expect(readNativeChatPlan({})).toBeNull()
    expect(readNativeChatPlan({ entries: null })).toBeNull()
    expect(
      readNativeChatPlan({
        entries: [
          { content: 'Finished first step', status: 'completed' },
          { content: 'Unknown remaining work', status: 'blocked' }
        ]
      })
    ).toBeNull()
    expect(readNativeChatPlan({ entries: [{ content: '', status: 'completed' }] })).toBeNull()
  })

  it('refuses oversized plans as a whole instead of reporting partial completion', () => {
    expect(
      readNativeChatPlan({
        entries: Array.from({ length: 129 }, () => ({ content: 'Step', status: 'completed' }))
      })
    ).toBeNull()
    expect(
      readNativeChatPlan({ entries: [{ content: 'x'.repeat(32_001), status: 'pending' }] })
    ).toBeNull()
  })

  it('keeps a readable checklist in the existing journal message contract for older clients', () => {
    const block = nativeChatPlanBlock({
      entries: [
        { content: 'Inspect source', status: 'completed' },
        { content: 'Publish changes', status: 'in_progress' },
        { content: 'Verify deployment', status: 'pending' }
      ]
    })
    const serialized = JSON.parse(JSON.stringify(block))
    expect(
      isAdmissibleAgentJournalItemBody({ kind: 'message', role: 'system', blocks: [serialized] })
    ).toBe(true)
    expect(serialized.text).toBe(
      '- [x] Inspect source\n- [ ] Publish changes (in progress)\n- [ ] Verify deployment'
    )
    expect(nativeChatPlanBlock({ entries: [] }).text).toBe('Plan cleared.')
  })
})
