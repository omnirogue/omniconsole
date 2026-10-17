// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import { WorkflowFindProgress } from './WorkflowFindProgress'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
afterEach(cleanup)

const DONE: WorkflowFindTrail = {
  stage: 'done',
  pool: 40,
  source: 'generated',
  top: 5,
  overall: [],
  byCriterion: [],
  winner: { key: 'a', title: 'Crumb & Co', detail: '', by: 'Claude' }
}

describe('WorkflowFindProgress', () => {
  it('names the saved results files and shows them in their folder', async () => {
    const openInFileManager = vi.fn(async () => ({ ok: false as const, reason: 'not-found' }))
    Object.assign(window, { api: { shell: { openInFileManager } } })
    const folder = '/work/app/.omni/find'
    render(
      <WorkflowFindProgress
        running={false}
        trail={{
          ...DONE,
          saved: {
            folder,
            files: [`${folder}/2026-09-23-bakery.md`, `${folder}/2026-09-23-bakery.csv`]
          }
        }}
      />
    )
    expect(
      screen.getByText('Every option and score is saved: 2026-09-23-bakery.md and .csv')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    expect(openInFileManager).toHaveBeenCalledWith(`${folder}/2026-09-23-bakery.md`)
    // A file the person moved away is said plainly, not ignored.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Could not show the results files.')
    )
  })

  it('says why the results files could not be saved', () => {
    render(
      <WorkflowFindProgress running={false} trail={{ ...DONE, saved: { error: 'disk full' } }} />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not save the results files: disk full'
    )
  })
})
