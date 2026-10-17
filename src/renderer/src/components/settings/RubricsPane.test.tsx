// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedReviewRubric } from '../../../../shared/review-rubrics'
import { rubricsFile } from '../../../../shared/rubric-library'
import { RubricsPane } from './RubricsPane'

const store = vi.hoisted(() => ({
  settings: { reviewRubrics: [] as SavedReviewRubric[] },
  updateSettingsOrThrow: vi.fn(async (_update: unknown) => undefined)
}))
const files = vi.hoisted(() => ({ openText: vi.fn(), saveText: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof store) => unknown) => selector(store)
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const agentRubric: SavedReviewRubric = {
  name: 'Agent reply check',
  instructions: 'Judge whether the reply resolves the request.',
  kind: 'reply'
}
const otherRubric: SavedReviewRubric = {
  name: 'Team plan',
  instructions: 'Judge whether the plan is feasible.',
  kind: 'plan'
}
beforeEach(() => {
  store.settings = { reviewRubrics: [agentRubric, otherRubric] }
  store.updateSettingsOrThrow.mockClear()
  files.openText.mockReset()
  files.saveText.mockReset()
  Object.assign(window, { api: { export: files } })
})
afterEach(cleanup)

describe('RubricsPane', () => {
  it('shows agent-saved rubrics arriving in the shared settings library', () => {
    store.settings = { reviewRubrics: [] }
    const view = render(<RubricsPane />)
    expect(
      screen.getByText('No saved rubrics yet. Create one here or ask an agent to save one.')
    ).toBeInTheDocument()
    store.settings = { reviewRubrics: [agentRubric, otherRubric] }
    view.rerender(<RubricsPane />)
    fireEvent.click(screen.getByRole('button', { name: agentRubric.name }))
    expect(screen.getByRole('heading', { name: 'Saved rubrics' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Built-in rubrics' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: agentRubric.name })).toBeInTheDocument()
    expect(screen.getByLabelText('What to judge and how to judge it')).toHaveValue(
      agentRubric.instructions
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ad copy' }))
    expect(
      (screen.getByLabelText('What to judge and how to judge it') as HTMLTextAreaElement).value
    ).toContain('Judge ad copy')
  })

  it('updates the existing shared store only after explicit replacement', async () => {
    render(<RubricsPane />)
    const instructions = 'Judge whether the reply is accurate and answers the request.'
    fireEvent.change(screen.getByLabelText('What to judge and how to judge it'), {
      target: { value: instructions }
    })
    expect(screen.getByRole('button', { name: 'Save rubric' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Save rubric' }))
    await waitFor(() =>
      expect(store.updateSettingsOrThrow).toHaveBeenCalledWith({
        reviewRubrics: [otherRubric, { ...agentRubric, instructions }]
      })
    )
  })

  it('creates a rubric in the same store and protects built-in names', async () => {
    render(<RubricsPane />)
    fireEvent.click(screen.getByRole('button', { name: 'New rubric' }))
    fireEvent.change(screen.getByLabelText('Rubric name'), { target: { value: 'Fast reply' } })
    fireEvent.change(screen.getByLabelText('What to judge and how to judge it'), {
      target: { value: 'Judge reply clarity.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save rubric' }))
    await waitFor(() =>
      expect(store.updateSettingsOrThrow).toHaveBeenCalledWith({
        reviewRubrics: [
          agentRubric,
          otherRubric,
          { name: 'Fast reply', instructions: 'Judge reply clarity.' }
        ]
      })
    )
    store.updateSettingsOrThrow.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Ad copy' }))
    fireEvent.change(screen.getByLabelText('Rubric name'), { target: { value: 'Ad copy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save rubric' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Built-in rubrics cannot be replaced.'
    )
    expect(store.updateSettingsOrThrow).not.toHaveBeenCalled()
  })

  it('requires confirmation before an import replaces saved names', async () => {
    const imported = { ...agentRubric, instructions: 'Judge reply completeness.' }
    files.openText.mockResolvedValue({ success: true, content: rubricsFile([imported]) })
    render(<RubricsPane />)
    fireEvent.click(screen.getByRole('button', { name: 'Import rubrics' }))
    const replace = await screen.findByRole('button', { name: 'Replace and import' })
    expect(store.updateSettingsOrThrow).not.toHaveBeenCalled()
    fireEvent.click(replace)
    await waitFor(() =>
      expect(store.updateSettingsOrThrow).toHaveBeenCalledWith({
        reviewRubrics: [otherRubric, imported]
      })
    )
  })
})
