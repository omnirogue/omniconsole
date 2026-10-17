// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackofficeWorkFilterRow, withWorkSource } from './backoffice-work-filter-row'
import { EMPTY_WORK_FILTER } from './backoffice-work-labels'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en' }
}))

afterEach(cleanup)

function renderRow(source: 'all' | 'task' | 'received' | 'sent') {
  render(
    <BackofficeWorkFilterRow
      filter={{ ...EMPTY_WORK_FILTER, source }}
      choices={{ people: [], projects: ['omnirogue'] }}
      names={new Map()}
      allControls
      onChange={vi.fn()}
    />
  )
}

describe('BackofficeWorkFilterRow project control', () => {
  it('offers a project only over tasks, the one source whose rows carry one', () => {
    renderRow('task')
    expect(screen.getByLabelText('Project')).toBeTruthy()
    cleanup()
    renderRow('all')
    expect(screen.queryByLabelText('Project')).toBeNull()
    cleanup()
    renderRow('received')
    expect(screen.queryByLabelText('Project')).toBeNull()
  })

  it('drops a chosen project when the source widens past tasks', () => {
    const narrowed = { ...EMPTY_WORK_FILTER, source: 'task' as const, project: 'omnirogue' }
    expect(withWorkSource(narrowed, 'task').project).toBe('omnirogue')
    expect(withWorkSource(narrowed, 'all').project).toBe('all')
    expect(withWorkSource(narrowed, 'sent').project).toBe('all')
  })
})
