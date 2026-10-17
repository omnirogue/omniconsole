// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rubricsFile } from '../../../../shared/rubric-library'
import { WorkflowRubricFields } from './WorkflowRubricFields'

const store = vi.hoisted(() => ({
  settings: {
    reviewRubrics: [{ name: 'Our ads', instructions: '- Short\n- Honest', kind: 'ads' }]
  },
  updateSettingsOrThrow: vi.fn(async (_update: unknown) => undefined)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof store) => unknown) => selector(store)
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// A native select stands in for the Radix one, so the test picks options directly.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <select
      aria-label="Rubric"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectLabel: ({ children }: { children: ReactNode }) => (
    <option disabled>{`group: ${String(children)}`}</option>
  ),
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

const saveText = vi.fn()
const openText = vi.fn()
beforeEach(() => {
  saveText.mockReset()
  openText.mockReset()
  store.updateSettingsOrThrow.mockClear()
  Object.assign(window, { api: { export: { saveText, openText } } })
})
afterEach(cleanup)

describe('WorkflowRubricFields', () => {
  it('offers the library grouped by what each rubric judges, yours first', () => {
    render(
      <WorkflowRubricFields id="t" instruction="" onInstruction={vi.fn()} placeholder="" hint="" />
    )
    const groups = screen.getAllByRole('option').map((option) => option.textContent)
    expect(groups.indexOf('group: Yours')).toBeLessThan(groups.indexOf('group: Ads'))
    expect(groups).toContain('Ad copy')
    expect(groups).toContain('Customer reply')
    expect(groups).toContain('Our ads')
  })

  it('puts the chosen rubric in the instruction and keeps what else matters', () => {
    const onInstruction = vi.fn()
    render(
      <WorkflowRubricFields
        id="t"
        instruction="- Under 90 words"
        onInstruction={onInstruction}
        placeholder=""
        hint=""
      />
    )
    fireEvent.change(screen.getByLabelText('Rubric'), { target: { value: 'library:ad-copy' } })
    const instruction = onInstruction.mock.calls.at(-1)![0] as string
    expect(instruction.startsWith('Rubric: Ad copy\nJudge ad copy')).toBe(true)
    expect(instruction).toContain('- Under 90 words')
  })

  it('exports the saved rubrics as a file, and imports a team file into them', async () => {
    saveText.mockResolvedValue({ success: true, filePath: '/tmp/omni-rubrics.json' })
    openText.mockResolvedValue({
      success: true,
      filePath: '/tmp/team.json',
      content: rubricsFile([
        { name: 'Team replies', instructions: '- Kind\n- Correct', kind: 'reply' }
      ])
    })
    render(
      <WorkflowRubricFields id="t" instruction="" onInstruction={vi.fn()} placeholder="" hint="" />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export your rubrics' }))
    await waitFor(() => expect(saveText).toHaveBeenCalled())
    expect(saveText.mock.calls[0]![0].content).toContain('"format": "omni-rubrics"')
    fireEvent.click(screen.getByRole('button', { name: 'Import rubrics' }))
    await waitFor(() => expect(store.updateSettingsOrThrow).toHaveBeenCalled())
    expect(store.updateSettingsOrThrow.mock.calls.at(-1)![0]).toEqual({
      reviewRubrics: [
        { name: 'Our ads', instructions: '- Short\n- Honest', kind: 'ads' },
        { name: 'Team replies', instructions: '- Kind\n- Correct', kind: 'reply' }
      ]
    })
  })
})
