import { describe, expect, it } from 'vitest'
import { nativeChatPlanBlock } from './native-chat-plan'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'
import { latestSessionTodoList } from './session-todo-list'

function assistant(id: string, blocks: NativeChatBlock[]): NativeChatMessage {
  return { id, role: 'assistant', blocks, timestamp: null, source: 'transcript' }
}

describe('latestSessionTodoList', () => {
  it('prefers a tool-published list over a newer written plan', () => {
    const messages = [
      assistant('1', [
        {
          type: 'tool-call',
          name: 'update_plan',
          input: { plan: [{ step: 'Tool step', status: 'in_progress' }] }
        }
      ]),
      assistant('2', [{ type: 'text', text: '1. Written\n2. Plan' }])
    ]
    expect(latestSessionTodoList(messages)).toEqual({
      todos: [{ text: 'Tool step', status: 'current' }],
      source: 'tool'
    })
  })

  it('reads a structured plan block', () => {
    const block = nativeChatPlanBlock({
      entries: [
        { content: 'First', status: 'completed' },
        { content: 'Second', status: 'in_progress' }
      ]
    })
    const messages: NativeChatMessage[] = [
      { id: 'p', role: 'system', blocks: [block], timestamp: null, source: 'transcript' }
    ]
    expect(latestSessionTodoList(messages)).toEqual({
      todos: [
        { text: 'First', status: 'completed' },
        { text: 'Second', status: 'current' }
      ],
      source: 'tool'
    })
  })

  it('falls back to a written plan only when no tool list exists', () => {
    const messages = [assistant('1', [{ type: 'text', text: '- [x] Done\n- [ ] Next' }])]
    expect(latestSessionTodoList(messages)).toEqual({
      todos: [
        { text: 'Done', status: 'completed' },
        { text: 'Next', status: 'pending' }
      ],
      source: 'text'
    })
  })

  it('reports an emptied tool list as no list', () => {
    const messages = [
      assistant('1', [{ type: 'text', text: '1. a\n2. b' }]),
      assistant('2', [{ type: 'tool-call', name: 'TodoWrite', input: { todos: [] } }])
    ]
    expect(latestSessionTodoList(messages)).toEqual({ todos: [], source: 'none' })
  })
})
