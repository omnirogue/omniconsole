// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NextStepHandoffOptions } from '../../../../shared/next-step-draft'
import { NextStepHandoffFields } from './NextStepHandoffFields'
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({
    files: ['result.md'],
    loading: false,
    loadError: null,
    truncated: false
  })
}))
afterEach(cleanup)
it('keeps message-only, selected file/folder, and history choices independent', () => {
  const changes = vi.fn()
  function Harness() {
    const [value, setValue] = useState<NextStepHandoffOptions>({
      task: null,
      deliverables: { kind: 'files', paths: [] },
      includeSummary: true
    })
    return (
      <NextStepHandoffFields
        value={value}
        onChange={(next) => {
          changes(next)
          setValue(next)
        }}
        worktreeId="folder:work"
        workspacePath="/work"
        hostId="local"
        historyAvailable
      />
    )
  }
  render(<Harness />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include final summary' }))
  expect(changes).toHaveBeenLastCalledWith(
    expect.objectContaining({ includeSummary: false, deliverables: { kind: 'files', paths: [] } })
  )
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include complete session history' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add from workspace…' }))
  fireEvent.click(screen.getByRole('button', { name: 'result.md' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Find a work file' }), {
    target: { value: 'reports' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add file or folder path' }))
  expect(changes).toHaveBeenLastCalledWith(
    expect.objectContaining({
      includeSummary: false,
      includeTranscript: true,
      deliverables: { kind: 'files', paths: ['/work/result.md', '/work/reports'] }
    })
  )
})
