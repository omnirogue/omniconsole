import { describe, expect, it } from 'vitest'
import { latestNativeChatTodoList } from './native-chat-todo-list'
import type { NativeChatMessage } from './native-chat-types'

function message(id: string, blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 1_000, source: 'transcript' }
}

function todoCall(
  todos: { content: string; status: string }[]
): NativeChatMessage['blocks'][number] {
  return { type: 'tool-call', name: 'TodoWrite', input: { todos } }
}

describe('latestNativeChatTodoList', () => {
  it('is empty for a transcript with no task list — the common case', () => {
    expect(
      latestNativeChatTodoList([
        message('1', [{ type: 'text', text: 'Looking into it.' }]),
        message('2', [{ type: 'tool-call', name: 'Bash', input: { command: 'ls' } }])
      ])
    ).toEqual([])
  })

  it('reads the newest published list, not an earlier one', () => {
    const todos = latestNativeChatTodoList([
      message('1', [todoCall([{ content: 'Old task', status: 'pending' }])]),
      message('2', [{ type: 'text', text: 'Working.' }]),
      message('3', [todoCall([{ content: 'New task', status: 'in_progress' }])])
    ])
    expect(todos).toEqual([{ text: 'New task', status: 'current' }])
  })

  it('reports no list when the agent cleared its list', () => {
    expect(
      latestNativeChatTodoList([
        message('1', [todoCall([{ content: 'Old task', status: 'pending' }])]),
        message('2', [{ type: 'tool-call', name: 'TodoWrite', input: { todos: [] } }])
      ])
    ).toEqual([])
  })

  it('reads the last block of a message that carries several tool calls', () => {
    expect(
      latestNativeChatTodoList([
        message('1', [
          { type: 'tool-call', name: 'Read', input: { file: 'a.ts' } },
          todoCall([{ content: 'Second call wins', status: 'completed' }])
        ])
      ])
    ).toEqual([{ text: 'Second call wins', status: 'completed' }])
  })

  it('does not scan past its limit, so an ancient list is not shown as current', () => {
    const messages = [
      message('old', [todoCall([{ content: 'Ancient', status: 'pending' }])]),
      ...Array.from({ length: 5 }, (_, index) =>
        message(`n${index}`, [{ type: 'text', text: 'chatter' }])
      )
    ]
    expect(latestNativeChatTodoList(messages, 3)).toEqual([])
    expect(latestNativeChatTodoList(messages)).toEqual([{ text: 'Ancient', status: 'pending' }])
  })
})
