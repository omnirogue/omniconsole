import { describe, expect, it } from 'vitest'
import {
  AGENT_TODO_MAX_ITEMS,
  agentTodoProgress,
  isAgentTodoToolName,
  parseAgentTodoList,
  withAgentTodoKeys
} from './agent-todo-list'

describe('isAgentTodoToolName', () => {
  it('recognises the publishers that exist, case and spacing insensitive', () => {
    expect(isAgentTodoToolName('TodoWrite')).toBe(true)
    expect(isAgentTodoToolName(' todo_write ')).toBe(true)
    expect(isAgentTodoToolName('update_plan')).toBe(true)
  })

  it('does not claim an unrelated tool publishes a task list', () => {
    expect(isAgentTodoToolName('Edit')).toBe(false)
    expect(isAgentTodoToolName('Bash')).toBe(false)
    expect(isAgentTodoToolName('')).toBe(false)
  })
})

describe('parseAgentTodoList', () => {
  it("reads Claude's TodoWrite shape", () => {
    expect(
      parseAgentTodoList({
        todos: [
          { content: 'Read the brief', status: 'completed', activeForm: 'Reading the brief' },
          { content: 'Write the tests', status: 'in_progress' },
          { content: 'Open the PR', status: 'pending' }
        ]
      })
    ).toEqual([
      { text: 'Read the brief', status: 'completed' },
      { text: 'Write the tests', status: 'current' },
      { text: 'Open the PR', status: 'pending' }
    ])
  })

  it("reads Codex's plan shape", () => {
    expect(
      parseAgentTodoList({
        plan: [
          { step: 'Reproduce the bug', status: 'done' },
          { step: 'Fix it', status: 'active' }
        ]
      })
    ).toEqual([
      { text: 'Reproduce the bug', status: 'completed' },
      { text: 'Fix it', status: 'current' }
    ])
  })

  it('accepts a JSON string, because sources disagree on whether input arrives parsed', () => {
    expect(parseAgentTodoList('{"todos":[{"content":"Ship it","status":"pending"}]}')).toEqual([
      { text: 'Ship it', status: 'pending' }
    ])
  })

  it('returns nothing for payloads that are not task lists', () => {
    expect(parseAgentTodoList(undefined)).toEqual([])
    expect(parseAgentTodoList('not json')).toEqual([])
    expect(parseAgentTodoList({ command: 'ls -la' })).toEqual([])
    expect(parseAgentTodoList({ todos: [] })).toEqual([])
    expect(parseAgentTodoList({ todos: [{ status: 'pending' }] })).toEqual([])
  })

  it('treats an unknown status as still to do rather than as progress', () => {
    expect(parseAgentTodoList({ todos: [{ content: 'A', status: 'weird' }] })).toEqual([
      { text: 'A', status: 'pending' }
    ])
  })

  it('bounds a runaway payload', () => {
    const todos = parseAgentTodoList({
      todos: Array.from({ length: AGENT_TODO_MAX_ITEMS + 20 }, (_, index) => ({
        content: `task ${index}`,
        status: 'pending'
      }))
    })
    expect(todos).toHaveLength(AGENT_TODO_MAX_ITEMS)
  })
})

describe('withAgentTodoKeys', () => {
  it('keys a task by its wording, so a key follows the task as the list reorders', () => {
    const todos = [
      { text: 'Write the tests', status: 'current' as const },
      { text: 'Open the PR', status: 'pending' as const }
    ]
    const keys = withAgentTodoKeys(todos).map((todo) => todo.key)
    const reordered = withAgentTodoKeys([todos[1]!, todos[0]!]).map((todo) => todo.key)
    expect(keys).toEqual(['Write the tests', 'Open the PR'])
    expect(reordered).toEqual(['Open the PR', 'Write the tests'])
  })

  it('keeps repeated wording unique', () => {
    expect(
      withAgentTodoKeys([
        { text: 'Retry', status: 'completed' },
        { text: 'Retry', status: 'pending' }
      ]).map((todo) => todo.key)
    ).toEqual(['Retry', 'Retry#1'])
  })
})

describe('agentTodoProgress', () => {
  it('counts what is done and names the task in progress', () => {
    expect(
      agentTodoProgress([
        { text: 'A', status: 'completed' },
        { text: 'B', status: 'current' },
        { text: 'C', status: 'pending' }
      ])
    ).toEqual({ completed: 1, total: 3, current: { text: 'B', status: 'current' } })
  })

  it('falls back to the first unfinished task when nothing is marked in progress', () => {
    expect(
      agentTodoProgress([
        { text: 'A', status: 'completed' },
        { text: 'B', status: 'pending' }
      ]).current
    ).toEqual({ text: 'B', status: 'pending' })
  })

  it('has no current task once everything is done', () => {
    expect(agentTodoProgress([{ text: 'A', status: 'completed' }])).toEqual({
      completed: 1,
      total: 1,
      current: null
    })
  })
})
