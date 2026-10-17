// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionFollowUpDeliverables } from '../../../../shared/session-follow-up-rule'
import { NextStepWorkFiles } from './NextStepWorkFiles'

const inventory = vi.hoisted(() => ({
  files: ['report.md', 'notes.txt', '../outside.txt'],
  loading: false,
  loadError: null as string | null
}))
vi.mock('@/components/quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => inventory
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

const defaults: SessionFollowUpDeliverables = { kind: 'manifest', manifestPath: '/w/results.md' }
function Picker({ initial = defaults }: { initial?: SessionFollowUpDeliverables }) {
  const [value, setValue] = useState<SessionFollowUpDeliverables | null>(initial)
  return (
    <>
      <NextStepWorkFiles
        worktreeId="folder:f1"
        workspacePath="/w"
        deliverables={value}
        defaults={defaults}
        onChange={setValue}
      />
      <output>{JSON.stringify(value)}</output>
    </>
  )
}
beforeEach(() => {
  inventory.files = ['report.md', 'notes.txt', '../outside.txt']
  inventory.loading = false
  inventory.loadError = null
})
afterEach(cleanup)

it('can search, remove a selection, and restore the run’s default deliverables', () => {
  render(<Picker />)
  fireEvent.click(screen.getByRole('button', { name: 'Add from workspace…' }))
  expect(screen.queryByRole('button', { name: '../outside.txt' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Find a work file'), { target: { value: 'REPORT' } })
  expect(screen.queryByRole('button', { name: 'notes.txt' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'report.md' }))
  expect(screen.getByRole('status').textContent).toContain('/w/report.md')
  fireEvent.click(screen.getByRole('button', { name: 'Remove report.md' }))
  expect(screen.getByRole('status').textContent).toBe('{"kind":"files","paths":[]}')
  fireEvent.click(screen.getByRole('button', { name: 'Use the run’s final deliverables' }))
  expect(screen.getByRole('status').textContent).toBe(JSON.stringify(defaults))
})

it('reserves a delivery slot for the summary and lets the person free a file slot', () => {
  inventory.files = Array.from({ length: 32 }, (_, index) => `file-${index}.txt`)
  render(
    <Picker
      initial={{ kind: 'files', paths: inventory.files.slice(0, 31).map((file) => `/w/${file}`) }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Add from workspace…' }))
  expect((screen.getByRole('button', { name: 'file-31.txt' }) as HTMLButtonElement).disabled).toBe(
    true
  )
  expect(
    screen.getByText('Up to 31 files or folders can be selected with these options.')
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'file-0.txt' }))
  expect((screen.getByRole('button', { name: 'file-31.txt' }) as HTMLButtonElement).disabled).toBe(
    false
  )
})

it('shows a failed host lookup without offering stale files', () => {
  inventory.loadError = 'Reconnect to this work location to choose files.'
  render(<Picker />)
  fireEvent.click(screen.getByRole('button', { name: 'Add from workspace…' }))
  expect(screen.getByRole('alert').textContent).toBe(inventory.loadError)
  expect(screen.queryByRole('button', { name: 'report.md' })).toBeNull()
})
