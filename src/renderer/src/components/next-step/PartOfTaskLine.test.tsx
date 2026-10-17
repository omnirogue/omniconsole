// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useBackofficeWorkFocus } from '@/components/task-page/backoffice/backoffice-work-selection'
import type { BackofficeTodoItem } from '../../../../shared/backoffice-work-types'
import { PartOfTaskLine } from './PartOfTaskLine'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: Record<string, string>) =>
    Object.entries(vars ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, value),
      fallback
    ),
  i18n: { language: 'en' }
}))
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => 'sal' }))
const folders = vi.hoisted(() => ({
  companies: [
    {
      id: 'org_1',
      slug: 'omnirogue',
      name: 'OmniRogue',
      domains: [{ id: 'unit_1', name: 'Development' }]
    }
  ]
}))
vi.mock('@/components/companies/use-work-folders', () => ({
  useWorkFolders: () => ({ data: { companies: folders.companies }, error: null, loading: false }),
  useWorkFoldersScope: () => 'scope-a'
}))

const card: BackofficeTodoItem = {
  task_id: 'btk_parent',
  title: 'Ship the launch',
  company_slug: 'omnirogue',
  org_unit_id: 'unit_1',
  due_date: '2026-09-20'
}

afterEach(cleanup)

describe('PartOfTaskLine', () => {
  it('renders nothing while the pane is unbound', () => {
    const { container } = render(<PartOfTaskLine card={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders the task, its company › domain and due date from the linked card', () => {
    render(<PartOfTaskLine card={card} />)
    expect(
      screen.getByText('Part of: Ship the launch · OmniRogue › Development · due 2026-09-20')
    ).toBeTruthy()
  })

  it('asks the Work list to open the same card on click, like Attention and deep links do', () => {
    const openTaskPage = vi.fn()
    useAppStore.setState({ openTaskPage } as never)
    const focus = vi.spyOn(useBackofficeWorkFocus.getState(), 'focus')
    render(<PartOfTaskLine card={card} />)
    fireEvent.click(screen.getByRole('button', { name: /Part of: Ship the launch/ }))
    expect(focus).toHaveBeenCalledWith({ scope: 'sal', taskId: 'btk_parent' })
    expect(openTaskPage).toHaveBeenCalledWith({ taskSource: 'backoffice' })
  })
})
