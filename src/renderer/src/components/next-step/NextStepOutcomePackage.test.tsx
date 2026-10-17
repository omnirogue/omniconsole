// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NextStepHandoffOptions } from '../../../../shared/next-step-draft'
import type { NextStepOutcomeFacts } from './next-step-outcome-facts'

const picker = vi.hoisted(() => ({ pickFiles: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/components/quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({ files: [], loading: false, loadError: null })
}))
vi.mock('./use-transcript-preview', () => ({
  useTranscriptPreview: (_subject: unknown, included: boolean) => ({
    offered: true,
    preview: included ? { messageCount: 12, sizeBytes: 2048 } : null,
    error: null,
    pending: false
  })
}))
import {
  NextStepOutcomePackage,
  NextStepOutcomePackageLine,
  packageSummary
} from './NextStepOutcomePackage'
afterEach(cleanup)
beforeEach(() => {
  picker.pickFiles.mockReset()
  Object.assign(window, { api: { shell: { pickFiles: picker.pickFiles } } })
})

const facts = (hostId: 'local' | 'ssh:box' = 'local'): NextStepOutcomeFacts => ({
  session: { worktreeId: 'folder:work', hostId, paneKey: 'tab:pane', label: 'Work' } as never,
  workspacePath: '/work',
  branch: null,
  repoId: null,
  repoName: null,
  model: null,
  summary: null,
  task: null,
  defaultDeliverables: null
})

function Harness({
  hostId,
  timing,
  initial,
  historyAvailable,
  teamRecipient
}: {
  hostId?: 'local' | 'ssh:box'
  timing?: 'now' | 'done'
  initial?: Partial<NextStepHandoffOptions>
  historyAvailable?: boolean
  teamRecipient?: boolean
}) {
  const [handoff, setHandoff] = useState<NextStepHandoffOptions>({
    task: null,
    deliverables: null,
    includeSummary: true,
    ...initial
  })
  return (
    <>
      <NextStepOutcomePackage
        facts={facts(hostId)}
        handoff={handoff}
        onHandoffChange={(patch) => setHandoff((current) => ({ ...current, ...patch }))}
        timing={timing}
        historyAvailable={historyAvailable}
        teamRecipient={teamRecipient}
      />
      <output>{JSON.stringify(handoff)}</output>
    </>
  )
}
const read = (): NextStepHandoffOptions => JSON.parse(screen.getByRole('status').textContent!)

it('lets the final summary be left out; Files opens the native picker and the workspace search', async () => {
  picker.pickFiles.mockResolvedValue(['/work/report.md', '/work/data.csv'])
  render(<Harness timing="now" />)
  const summary = screen.getByRole('checkbox', { name: 'Include final summary' })
  expect(summary.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(summary)
  expect(read().includeSummary).toBe(false)
  fireEvent.click(summary)
  expect(read().includeSummary).toBe(true)
  expect(screen.queryByRole('button', { name: 'Add files…' })).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Files' }))
  expect(screen.getByRole('button', { name: 'Add from workspace…' })).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add files…' }))
  })
  expect(picker.pickFiles).toHaveBeenCalledWith({ defaultPath: '/work', multiple: true })
  expect(read().deliverables).toEqual({
    kind: 'files',
    paths: ['/work/report.md', '/work/data.csv']
  })
  picker.pickFiles.mockResolvedValue(['/work/data.csv', '/work/notes.md'])
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add files…' }))
  })
  expect(read().deliverables).toEqual({
    kind: 'files',
    paths: ['/work/report.md', '/work/data.csv', '/work/notes.md']
  })
  expect(screen.getByText('Files · 3')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Files · 3' }))
  expect(read().deliverables).toBeNull()
  expect(screen.queryByRole('button', { name: 'Add from workspace…' })).toBeNull()
})

it('explains the files it filled in, offers another look, and says when none were found', () => {
  const refresh = vi.fn()
  render(
    <NextStepOutcomePackage
      facts={facts()}
      handoff={{
        task: null,
        deliverables: { kind: 'files', paths: ['/work/report.md', '/work/data.csv'] },
        includeSummary: true
      }}
      onHandoffChange={() => {}}
      timing="done"
      autoFiles={{
        detected: { paths: ['/work/report.md', '/work/data.csv'], truncated: false },
        loading: false,
        refresh
      }}
    />
  )
  expect(
    screen.getByText('2 changed in this workspace, captured when the work finishes.')
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Look again' }))
  expect(refresh).toHaveBeenCalledTimes(1)
  cleanup()
  render(
    <NextStepOutcomePackage
      facts={facts()}
      handoff={{ task: null, deliverables: { kind: 'files', paths: [] }, includeSummary: true }}
      onHandoffChange={() => {}}
      timing="done"
      autoFiles={{ detected: null, loading: false, refresh }}
    />
  )
  expect(screen.getByText('No changed files found; add the files to send.')).toBeTruthy()
})

it('keeps the native picker off a remote host and reports a picker failure inline', async () => {
  render(<Harness hostId="ssh:box" timing="now" />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Files' }))
  expect(screen.queryByRole('button', { name: 'Add files…' })).toBeNull()
  cleanup()
  picker.pickFiles.mockRejectedValue(new Error('Dialog unavailable'))
  render(<Harness timing="now" />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Files' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add files…' }))
  })
  expect(screen.getByRole('alert').textContent).toBe('Dialog unavailable')
})

it('offers the full conversation with its consent and size, and says when it is captured', () => {
  render(<Harness timing="now" />)
  const box = screen.getByRole('checkbox', { name: 'Full conversation' })
  expect(box.getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByText(/History is captured after completion/)).toBeNull()
  fireEvent.click(box)
  expect(read().includeTranscript).toBe(true)
  expect(screen.getByText('12 messages, 2.0 KiB — sent as one file.')).toBeTruthy()
  cleanup()
  render(<Harness timing="done" initial={{ includeTranscript: true }} />)
  expect(screen.getByText(/^History is captured after completion\./)).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'Full conversation' }).hasAttribute('disabled')).toBe(
    false
  )
})

it('cannot promise the history to a when-done handoff whose source is not settled, and says why', () => {
  render(<Harness timing="done" historyAvailable={false} />)
  const box = screen.getByRole('checkbox', { name: 'Full conversation' })
  expect(box.hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(/The session history source cannot be verified/)).toBeTruthy()
  cleanup()
  // Why: Send now reads the transcript here, so an unsettled source only fails the preview.
  render(<Harness timing="now" historyAvailable={false} />)
  expect(screen.getByRole('checkbox', { name: 'Full conversation' }).hasAttribute('disabled')).toBe(
    false
  )
})

it('asks what kind of communication it is only when a teammate or agent receives the work', () => {
  render(<Harness timing="done" />)
  expect(screen.queryByRole('combobox', { name: 'Communication type' })).toBeNull()
  cleanup()
  render(<Harness timing="done" teamRecipient initial={{ communicationType: 'request' }} />)
  const select = screen.getByRole('combobox', { name: 'Communication type' })
  expect(select.textContent).toContain('Request')
  expect(screen.getByText('Take action')).toBeTruthy()
})

it('sums the package up in a few words for the line under the teammate', () => {
  const base = { task: null, deliverables: null, includeSummary: true }
  expect(packageSummary(base)).toBe('Final summary')
  expect(packageSummary({ ...base, includeSummary: false })).toBe('Note only')
  expect(
    packageSummary({
      ...base,
      deliverables: { kind: 'files', paths: ['/a', '/b'] },
      includeTranscript: true
    })
  ).toBe('Final summary, 2 files, full conversation')
  expect(packageSummary({ ...base, deliverables: { kind: 'files', paths: ['/a'] } })).toBe(
    'Final summary, 1 file'
  )
})

it('shows the package as one line that opens its boxes on click', () => {
  render(
    <NextStepOutcomePackageLine
      facts={facts()}
      handoff={{ task: null, deliverables: null, includeSummary: true }}
      onHandoffChange={() => {}}
      timing="now"
    />
  )
  expect(screen.queryByRole('checkbox')).toBeNull()
  const line = screen.getByRole('button', { name: 'Package · Final summary' })
  fireEvent.click(line)
  expect(screen.getByRole('checkbox', { name: 'Include final summary' })).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'Files' })).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'Full conversation' })).toBeTruthy()
})
