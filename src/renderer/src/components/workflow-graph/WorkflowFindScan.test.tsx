// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowFindScan } from './WorkflowFindScan'
import { WorkflowFindList } from './WorkflowFindList'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values?.[key] ?? ''))
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('Find Scan import controls', () => {
  it('imports a file with details and reports skipped rows', async () => {
    const onItems = vi.fn()
    render(<WorkflowFindScan onItems={onItems} />)
    fireEvent.click(screen.getByRole('button', { name: 'Import a list' }))
    fireEvent.change(screen.getByLabelText('Import a list from a file'), {
      target: {
        files: [
          {
            name: 'options.csv',
            size: 60,
            text: async () => 'name,description\nA,first\n,missing\nB,second'
          }
        ]
      }
    })
    await waitFor(() =>
      expect(onItems).toHaveBeenCalledWith(
        [
          { title: 'A', detail: 'first' },
          { title: 'B', detail: 'second' }
        ],
        {
          read: 3,
          imported: 2,
          skipped: [{ line: 2, reason: 'no title' }],
          merged: 0
        }
      )
    )
    expect(screen.getByRole('status')).toHaveTextContent('2 options imported; 1 rows skipped.')
  })
  it('keeps structured details visible without turning them into strings', () => {
    render(
      <WorkflowFindList
        items={[{ title: 'A', detail: 'Detail', url: 'https://example.com' }]}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByLabelText('Imported options')).toHaveValue(
      'A — Detail — https://example.com'
    )
    expect(screen.getByLabelText('Imported options')).toHaveAttribute('readonly')
  })
})
