// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionContextAttachment } from '../../../../shared/session-context-attachments'
import { ProjectSettingsNotes } from './ProjectSettingsNotes'

afterEach(cleanup)

const decisions: SessionContextAttachment = { id: 'slite:1', kind: 'slite', title: 'Decisions' }
const spec: SessionContextAttachment = { id: 'slite:2', kind: 'slite', title: 'Spec', notes: true }
const skill: SessionContextAttachment = { id: 'skill-name:x', kind: 'skill', title: 'x' }

it('stays hidden until a Slite document is attached', () => {
  const { container } = render(<ProjectSettingsNotes attachments={[skill]} onChange={vi.fn()} />)
  expect(container.innerHTML).toBe('')
})

it('marks the picked document as the notes and clears the old mark', () => {
  const onChange = vi.fn()
  render(<ProjectSettingsNotes attachments={[skill, decisions, spec]} onChange={onChange} />)
  expect((screen.getByRole('radio', { name: 'Spec' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: 'Decisions' }))
  expect(onChange).toHaveBeenCalledWith([
    skill,
    { ...decisions, notes: true },
    { id: 'slite:2', kind: 'slite', title: 'Spec' }
  ])
})

it('None clears the mark', () => {
  const onChange = vi.fn()
  render(<ProjectSettingsNotes attachments={[spec]} onChange={onChange} />)
  fireEvent.click(screen.getByRole('radio', { name: 'None' }))
  expect(onChange).toHaveBeenCalledWith([{ id: 'slite:2', kind: 'slite', title: 'Spec' }])
})
