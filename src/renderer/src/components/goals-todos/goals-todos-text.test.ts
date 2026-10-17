import { describe, expect, it } from 'vitest'
import type { AgentTodo } from '../../../../shared/agent-todo-list'
import type { GoalsTodosDetails } from './goals-todos-rows'
import { goalsTodosStepLabel, sessionTodoBadge } from './goals-todos-text'

function details(
  todos: AgentTodo[],
  goal: string | null = 'Ship the pricing page'
): GoalsTodosDetails {
  return {
    goal: goal ? { line: goal, full: goal } : null,
    todos,
    source: todos.length > 0 ? 'tool' : 'none',
    lastMessageAt: null
  }
}

const done = (text: string): AgentTodo => ({ text, status: 'completed' })
const current = (text: string): AgentTodo => ({ text, status: 'current' })
const pending = (text: string): AgentTodo => ({ text, status: 'pending' })

describe('sessionTodoBadge', () => {
  it('shows nothing before a read finished or when the session has no list', () => {
    expect(sessionTodoBadge(null)).toBeNull()
    expect(sessionTodoBadge(details([]))).toBeNull()
  })

  it('counts done items over the whole list, with the goal and current step for the hover', () => {
    const badge = sessionTodoBadge(
      details([done('Plan'), done('Draft'), done('Review'), current('Fix copy'), pending('Ship')])
    )
    expect(badge).toEqual({
      text: '3/5',
      label: '3 of 5 done',
      done: false,
      goal: 'Ship the pricing page',
      step: 'Now: Fix copy'
    })
  })

  it('names the next step when nothing is marked in progress', () => {
    const badge = sessionTodoBadge(details([done('Plan'), pending('Draft')], null))
    expect(badge?.text).toBe('1/2')
    expect(badge?.goal).toBeNull()
    expect(badge?.step).toBe('Next: Draft')
  })

  it('reads as finished once every item is done', () => {
    const badge = sessionTodoBadge(details([done('Plan'), done('Ship')]))
    expect(badge).toMatchObject({ text: '2/2', label: 'All 2 done', done: true, step: null })
  })
})

describe('goalsTodosStepLabel', () => {
  it('has no step once the list is complete', () => {
    expect(goalsTodosStepLabel({ completed: 2, total: 2, current: null })).toBeNull()
  })
})
