// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SAVED_REVIEW_RUBRICS_MAX,
  type ReviewRubric,
  type SavedReviewRubric
} from '../../../../shared/review-rubrics'
import { rubricLibrary, rubricsFile } from '../../../../shared/rubric-library'
import { ReviewRubricPicker } from './ReviewRubricPicker'

const store = vi.hoisted(() => ({
  settings: { reviewRubrics: [] as SavedReviewRubric[] },
  updateSettingsOrThrow: vi.fn(async (_update: unknown) => undefined)
}))
const files = vi.hoisted(() => ({ openText: vi.fn(), saveText: vi.fn() }))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof store) => unknown) => selector(store)
}))
vi.mock('sonner', () => ({ toast: toasts }))

const ourAds: SavedReviewRubric = {
  name: 'Our ads',
  instructions: '- Short\n- Honest',
  kind: 'ads'
}
const teamPlan: SavedReviewRubric = {
  name: 'Team plan',
  instructions: '- Feasible\n- Measured',
  kind: 'plan'
}
const adCopy = rubricLibrary([]).find((entry) => entry.value === 'library:ad-copy')!.rubric
const fullLibrary = () =>
  Array.from({ length: SAVED_REVIEW_RUBRICS_MAX }, (_, index) => ({
    name: `Saved ${index}`,
    instructions: 'Existing rubric'
  }))

beforeEach(() => {
  store.settings = { reviewRubrics: [ourAds, teamPlan] }
  store.updateSettingsOrThrow.mockReset()
  store.updateSettingsOrThrow.mockResolvedValue(undefined)
  files.openText.mockReset()
  files.saveText.mockReset()
  toasts.success.mockReset()
  toasts.error.mockReset()
  Object.assign(window, { api: { export: files } })
})
afterEach(cleanup)

function renderPicker(rubric: ReviewRubric = adCopy) {
  const onChange = vi.fn()
  render(<ReviewRubricPicker id="seat" rubric={rubric} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  return onChange
}

function saveAs(name: string) {
  fireEvent.change(screen.getByLabelText('Name to save it under'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Save rubric' }))
}

function importFile(rubrics: SavedReviewRubric[]) {
  files.openText.mockResolvedValue({ success: true, content: rubricsFile(rubrics) })
  fireEvent.click(screen.getByRole('button', { name: 'Import rubrics' }))
}

describe('ReviewRubricPicker save', () => {
  it('refuses a built-in name or value, as Settings and agents do', async () => {
    const onChange = renderPicker()
    for (const name of ['Ad copy', 'library:ad-copy', 'general']) {
      saveAs(name)
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Built-in rubrics cannot be replaced.'
      )
    }
    expect(store.updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('replaces a saved rubric of the same name only after explicit replacement', async () => {
    const edited: ReviewRubric = {
      id: 'custom',
      name: ourAds.name,
      instructions: '- Short\n- Honest\n- Specific'
    }
    const onChange = renderPicker(edited)
    fireEvent.change(screen.getByLabelText('Name to save it under'), {
      target: { value: 'our ads' }
    })
    expect(screen.getByRole('button', { name: 'Save rubric' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Replace the saved rubric “Our ads”' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save rubric' }))
    const replaced = { name: 'our ads', instructions: edited.instructions, kind: 'ads' }
    await waitFor(() =>
      expect(store.updateSettingsOrThrow).toHaveBeenCalledWith({
        reviewRubrics: [teamPlan, replaced]
      })
    )
    expect(onChange).toHaveBeenCalledWith({
      id: 'custom',
      name: 'our ads',
      instructions: edited.instructions
    })
  })

  it('saves a new name with what its starter judges', async () => {
    const onChange = renderPicker()
    saveAs('Launch ads')
    await waitFor(() =>
      expect(store.updateSettingsOrThrow).toHaveBeenCalledWith({
        reviewRubrics: [
          ourAds,
          teamPlan,
          { name: 'Launch ads', instructions: adCopy.instructions, kind: 'ads' }
        ]
      })
    )
    expect(onChange).toHaveBeenCalledWith({
      id: 'custom',
      name: 'Launch ads',
      instructions: adCopy.instructions
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the saved limit', async () => {
    store.settings = { reviewRubrics: fullLibrary() }
    const onChange = renderPicker()
    saveAs('One more')
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved rubric limit reached.')
    expect(store.updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports a save the settings store did not keep', async () => {
    store.updateSettingsOrThrow.mockRejectedValueOnce(new Error('Settings could not be written.'))
    const onChange = renderPicker()
    saveAs('Launch ads')
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not be written.')
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('ReviewRubricPicker import', () => {
  it('refuses a file that names a built-in, and imports none of it', async () => {
    renderPicker()
    importFile([
      { name: 'Fresh ads', instructions: '- New', kind: 'ads' },
      { name: 'library:landing-page', instructions: '- Mine', kind: 'page' }
    ])
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith('Built-in rubrics cannot be replaced.')
    )
    expect(store.updateSettingsOrThrow).not.toHaveBeenCalled()
  })

  it('asks before an imported rubric replaces a saved one of the same name', async () => {
    const imported = { ...ourAds, instructions: '- Short\n- Honest\n- Local' }
    renderPicker()
    importFile([imported])
    const replace = await screen.findByRole('button', { name: 'Replace and import' })
    expect(store.updateSettingsOrThrow).not.toHaveBeenCalled()
    fireEvent.click(replace)
    await waitFor(() =>
      expect(store.updateSettingsOrThrow).toHaveBeenCalledWith({
        reviewRubrics: [teamPlan, imported]
      })
    )
    expect(toasts.success).toHaveBeenCalled()
  })

  it('refuses an import past the saved limit instead of leaving part of it out', async () => {
    store.settings = { reviewRubrics: fullLibrary() }
    renderPicker()
    importFile([{ name: 'One more', instructions: '- New', kind: 'other' }])
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Saved rubric limit reached.'))
    expect(store.updateSettingsOrThrow).not.toHaveBeenCalled()
  })
})
