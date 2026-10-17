// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionGoalTodosSection } from './SessionGoalTodosDetails'
import type { SessionGoalTodosView } from './session-goal-todos-view'

afterEach(cleanup)

function view(overrides: Partial<SessionGoalTodosView> = {}): SessionGoalTodosView {
  return { goal: null, todos: [], source: 'none', reading: false, ...overrides }
}

function section(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-next-action-section="todos"]')
  if (!found) {
    throw new Error('missing To-do section')
  }
  return found
}

describe('SessionGoalTodosSection', () => {
  it('shows no empty Goal row or To-do section once the read found nothing', () => {
    render(<SessionGoalTodosSection view={view()} />)
    expect(document.querySelector('[data-next-action-section="todos"]')).toBeNull()
    expect(document.querySelector('[data-next-action-fact="goal"]')).toBeNull()
    expect(document.body.textContent).not.toContain('No to-do list yet')
  })

  it('says it is reading before the first read lands', () => {
    render(<SessionGoalTodosSection view={view({ reading: true })} />)
    expect(section().textContent).toContain('Reading…')
  })

  it('shows progress and the checklist, with done items struck and the current one marked', () => {
    render(
      <SessionGoalTodosSection
        view={view({
          source: 'tool',
          todos: [
            { text: 'Plan', status: 'completed' },
            { text: 'Build', status: 'current' },
            { text: 'Test', status: 'pending' }
          ]
        })}
      />
    )
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
    expect(section().textContent).toContain('1 of 3 done')
    expect(section().textContent).not.toContain("(from the AI's written plan)")
    const items = section().querySelectorAll('[data-session-activity-todo]')
    expect([...items].map((item) => item.getAttribute('data-session-activity-todo'))).toEqual([
      'completed',
      'current',
      'pending'
    ])
    expect(items[0]?.querySelector('.line-through')?.textContent).toBe('Plan')
  })

  it('labels a list read from the written plan, and folds the list down to the current step', () => {
    render(
      <SessionGoalTodosSection
        view={view({
          source: 'text',
          todos: [
            { text: 'Draft', status: 'completed' },
            { text: 'Send', status: 'pending' }
          ]
        })}
      />
    )
    expect(section().textContent).toContain("(from the AI's written plan)")
    fireEvent.click(screen.getByRole('button', { name: 'Hide to-do list' }))
    expect(section().querySelector('[data-session-activity-todos]')).toBeNull()
    expect(section().textContent).toContain('Next: Send')
  })

  it('shows the goal on one line and expands to the full prompt', () => {
    const full = 'Rebuild the landing page.\n\nKeep the hero, swap the pricing table.'
    render(
      <SessionGoalTodosSection
        view={view({
          goal: { line: 'Rebuild the landing page. Keep the hero, swap the…', full }
        })}
      />
    )
    expect(document.querySelector('[data-session-goal-line]')?.textContent).toContain(
      'Rebuild the landing page.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'more' }))
    expect(document.querySelector('[data-session-goal-full]')?.textContent).toBe(full)
    expect(screen.getByRole('button', { name: 'less' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('offers no expander when the line already is the whole goal', () => {
    render(<SessionGoalTodosSection view={view({ goal: { line: 'Fix CI', full: 'Fix CI' } })} />)
    expect(screen.queryByRole('button', { name: 'more' })).toBeNull()
  })

  it('puts Progress before the To-do list and folds the list to its current step', () => {
    render(
      <SessionGoalTodosSection
        view={view({
          source: 'tool',
          todos: [
            { text: 'Plan', status: 'completed' },
            { text: 'Build', status: 'current' }
          ]
        })}
        progress={<p>milestones here</p>}
      />
    )
    const order = [...document.querySelectorAll('[data-next-action-section]')].map((node) =>
      node.getAttribute('data-next-action-section')
    )
    expect(order).toEqual(['progress', 'todos'])
    expect(screen.getByRole('region', { name: 'Progress' }).textContent).toBe(
      'Progressmilestones here'
    )
    expect(section().querySelector('[data-session-activity-todos]')).toBeNull()
    expect(section().textContent).toContain('Now: Build')
  })
})
