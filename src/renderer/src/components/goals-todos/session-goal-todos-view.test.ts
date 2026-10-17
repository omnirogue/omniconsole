import { describe, expect, it } from 'vitest'
import type { GoalsTodosDetails } from './goals-todos-rows'
import { sessionGoalTodosView } from './session-goal-todos-view'

const goal = { line: 'Fix the checkout bug', full: 'Fix the checkout bug' }

const read: GoalsTodosDetails = {
  goal,
  todos: [{ text: 'Reproduce', status: 'current' }],
  source: 'tool',
  lastMessageAt: null
}

describe('sessionGoalTodosView', () => {
  it('is reading while a readable session has no completed read and no chat list', () => {
    expect(sessionGoalTodosView({ details: null, fromMessages: null, canRead: true })).toEqual({
      goal: null,
      todos: [],
      source: 'none',
      reading: true
    })
  })

  it('is plainly empty when nothing on this computer can be read', () => {
    const view = sessionGoalTodosView({ details: null, fromMessages: null, canRead: false })
    expect(view.reading).toBe(false)
    expect(view.source).toBe('none')
  })

  it('uses the shared read for both the goal and the list', () => {
    const view = sessionGoalTodosView({ details: read, fromMessages: null, canRead: true })
    expect(view).toEqual({ goal, todos: read.todos, source: 'tool', reading: false })
  })

  it("prefers the chat view's own list, and keeps the goal from the shared read", () => {
    const fromMessages = {
      todos: [{ text: 'Write the fix', status: 'pending' as const }],
      source: 'text' as const
    }
    const view = sessionGoalTodosView({ details: read, fromMessages, canRead: true })
    expect(view.todos).toBe(fromMessages.todos)
    expect(view.source).toBe('text')
    expect(view.goal).toBe(goal)
  })

  it('falls back to the shared read when the chat window holds no list', () => {
    const view = sessionGoalTodosView({
      details: read,
      fromMessages: { todos: [], source: 'none' },
      canRead: true
    })
    expect(view.todos).toBe(read.todos)
  })
})
