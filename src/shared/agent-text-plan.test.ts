import { describe, expect, it } from 'vitest'
import { AGENT_TODO_MAX_ITEMS } from './agent-todo-list'
import { latestAssistantTextPlan, parseAgentTextPlan } from './agent-text-plan'
import type { NativeChatMessage } from './native-chat-types'

function message(role: NativeChatMessage['role'], text: string, id = text): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: null, source: 'transcript' }
}

describe('parseAgentTextPlan', () => {
  it('reads a markdown checklist, ticked items completed', () => {
    expect(
      parseAgentTextPlan('Plan:\n- [x] Read the brief\n- [ ] Write the parser\n- [ ] Open the PR')
    ).toEqual([
      { text: 'Read the brief', status: 'completed' },
      { text: 'Write the parser', status: 'pending' },
      { text: 'Open the PR', status: 'pending' }
    ])
  })

  it('reads a numbered plan as pending unless an item is marked done', () => {
    expect(
      parseAgentTextPlan(
        "Here's the plan:\n\n1. Find the reader ✅\n2. ~~Add the cache~~\n3. Wire the view (done)\n4. Write tests"
      )
    ).toEqual([
      { text: 'Find the reader', status: 'completed' },
      { text: 'Add the cache', status: 'completed' },
      { text: 'Wire the view', status: 'completed' },
      { text: 'Write tests', status: 'pending' }
    ])
  })

  it('marks an item flagged in progress as the current one', () => {
    expect(parseAgentTextPlan('- [x] One\n- [ ] Two (in progress)\n- [ ] Three')).toEqual([
      { text: 'One', status: 'completed' },
      { text: 'Two', status: 'current' },
      { text: 'Three', status: 'pending' }
    ])
  })

  it('reads bullets only under a to-do style heading', () => {
    expect(parseAgentTextPlan('**Next steps:**\n- Push the branch\n- Open the PR')).toEqual([
      { text: 'Push the branch', status: 'pending' },
      { text: 'Open the PR', status: 'pending' }
    ])
    expect(parseAgentTextPlan('Some thoughts:\n- this is\n- just prose')).toEqual([])
  })

  it('needs at least two items', () => {
    expect(parseAgentTextPlan('1. Only one step')).toEqual([])
    expect(parseAgentTextPlan('- [ ] Only one box')).toEqual([])
  })

  it('ignores numbering that does not start at 1 and anything inside code fences', () => {
    expect(parseAgentTextPlan('3. third\n4. fourth')).toEqual([])
    expect(parseAgentTextPlan('```\n1. not\n2. a plan\n```')).toEqual([])
  })

  it('keeps nested sub-items out of the plan', () => {
    expect(parseAgentTextPlan('1. First\n   1. detail\n   2. detail\n2. Second')).toEqual([
      { text: 'First', status: 'pending' },
      { text: 'Second', status: 'pending' }
    ])
  })

  it('does not read "done" inside a word as a completion mark', () => {
    expect(parseAgentTextPlan('1. Ship the hand-done fix\n2. Verify')).toEqual([
      { text: 'Ship the hand-done fix', status: 'pending' },
      { text: 'Verify', status: 'pending' }
    ])
  })

  it('bounds a pathological list', () => {
    const text = Array.from({ length: 80 }, (_, index) => `${index + 1}. step ${index}`).join('\n')
    expect(parseAgentTextPlan(text)).toHaveLength(AGENT_TODO_MAX_ITEMS)
  })
})

describe('latestAssistantTextPlan', () => {
  it('uses the newest assistant message that contains a plan', () => {
    const messages = [
      message('assistant', '1. Old\n2. Plan'),
      message('user', '1. user\n2. text'),
      message('assistant', '- [x] New\n- [ ] Plan'),
      message('assistant', 'All good, carrying on.')
    ]
    expect(latestAssistantTextPlan(messages)).toEqual([
      { text: 'New', status: 'completed' },
      { text: 'Plan', status: 'pending' }
    ])
  })

  it('never reads a plan out of user turns', () => {
    expect(latestAssistantTextPlan([message('user', '1. a\n2. b')])).toEqual([])
  })
})
