// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowJobEvidence } from './WorkflowJobEvidence'
import type { ConsoleJobEvidencePage } from '../../../../shared/console-job-evidence'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, value: string) => value }))
vi.mock('@/components/native-chat/NativeChatMessageList', () => ({
  NativeChatMessageList: ({ session }: { session: { messages: NativeChatMessage[] } }) => (
    <div data-testid="conversation-transcript">{JSON.stringify(session.messages)}</div>
  )
}))
const api = { readJobEvidence: vi.fn(), readJobLog: vi.fn(), listJobEvents: vi.fn() }
const base: ConsoleJobEvidencePage = {
  job_id: 'job_evidence01',
  attempt: 1,
  lease_generation: 2,
  host: 'mw0002',
  provider: 'codex',
  session_id: 'thread_1',
  entries: [{ id: 1, kind: 'input', text: 'Review this checkout', at: '2026-09-12T12:00:00Z' }],
  next_after: 1,
  has_more: false,
  complete: true
}
function openEvidence() {
  const details = screen.getByText('Session transcript and logs').closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
}
beforeEach(() => {
  vi.resetAllMocks()
  api.readJobEvidence.mockResolvedValue({ ok: true, data: base })
  api.listJobEvents.mockResolvedValue({
    ok: true,
    data: { job_id: base.job_id, events: [], next_after: 0, has_more: false }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { consoleWorkflows: api } })
})
afterEach(cleanup)

describe('workflow session evidence', () => {
  it('loads on demand and uses the same conversation renderer for captured messages', async () => {
    render(<WorkflowJobEvidence jobId={base.job_id} />)
    expect(api.readJobEvidence).not.toHaveBeenCalled()
    openEvidence()
    expect(await screen.findByTestId('conversation-transcript')).toHaveTextContent(
      'Review this checkout'
    )
    expect(api.readJobEvidence).toHaveBeenCalledExactlyOnceWith({
      jobId: base.job_id,
      attempt: undefined,
      leaseGeneration: undefined,
      after: 0,
      limit: 100
    })
    expect(screen.getByText('All captured session evidence is loaded.')).toBeInTheDocument()
    expect(api.readJobLog).not.toHaveBeenCalled()
  })

  it('pins the accepted attempt while loading more and reassembles a split record', async () => {
    api.readJobEvidence.mockResolvedValueOnce({
      ok: true,
      data: {
        ...base,
        entries: [{ ...base.entries[0], record_id: 4, part: 0, final: false, text: 'Original ' }],
        has_more: true
      }
    })
    api.readJobEvidence.mockResolvedValueOnce({
      ok: true,
      data: {
        ...base,
        entries: [
          { ...base.entries[0], id: 2, record_id: 4, part: 1, final: true, text: 'request' }
        ],
        next_after: 2
      }
    })
    render(<WorkflowJobEvidence jobId={base.job_id} />)
    openEvidence()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByTestId('conversation-transcript')).toHaveTextContent(
      'Original request'
    )
    expect(api.readJobEvidence).toHaveBeenLastCalledWith({
      jobId: base.job_id,
      attempt: 1,
      leaseGeneration: 2,
      after: 1,
      limit: 100
    })
  })

  it('shows raw captured session records and requests the full fleet event cursor', async () => {
    render(<WorkflowJobEvidence jobId={base.job_id} />)
    openEvidence()
    await screen.findByTestId('conversation-transcript')
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Session log' }), { button: 0 })
    fireEvent.click(screen.getByRole('tab', { name: 'Session log' }))
    expect(await screen.findByRole('tabpanel', { name: 'Session log' })).toHaveTextContent(
      'Review this checkout'
    )
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Event log' }), { button: 0 })
    fireEvent.click(screen.getByRole('tab', { name: 'Event log' }))
    await waitFor(() =>
      expect(api.listJobEvents).toHaveBeenCalledWith({
        jobId: base.job_id,
        placement: 'fleet',
        after: 0,
        limit: 200
      })
    )
  })

  it('keeps existing evidence when contact is lost and never claims capture completion', async () => {
    api.readJobEvidence.mockResolvedValueOnce({
      ok: true,
      data: { ...base, complete: false, has_more: true }
    })
    api.readJobEvidence.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unavailable', message: 'The host is unreachable.' }
    })
    render(<WorkflowJobEvidence jobId={base.job_id} />)
    openEvidence()
    await screen.findByTestId('conversation-transcript')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The host is unreachable.')
    expect(screen.getByTestId('conversation-transcript')).toHaveTextContent('Review this checkout')
    expect(screen.queryByText('All captured session evidence is loaded.')).not.toBeInTheDocument()
  })

  it('ignores an old attempt response after the selected job attempt changes', async () => {
    let resolveOld: (value: unknown) => void = () => {}
    api.readJobEvidence.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    api.readJobEvidence.mockResolvedValueOnce({
      ok: true,
      data: {
        ...base,
        attempt: 2,
        lease_generation: 3,
        entries: [{ ...base.entries[0], text: 'New attempt' }]
      }
    })
    const view = render(<WorkflowJobEvidence jobId={base.job_id} attempt={1} leaseGeneration={2} />)
    openEvidence()
    await waitFor(() => expect(api.readJobEvidence).toHaveBeenCalledTimes(1))
    view.rerender(<WorkflowJobEvidence jobId={base.job_id} attempt={2} leaseGeneration={3} />)
    expect(await screen.findByTestId('conversation-transcript')).toHaveTextContent('New attempt')
    resolveOld({ ok: true, data: base })
    await waitFor(() =>
      expect(screen.getByTestId('conversation-transcript')).not.toHaveTextContent(
        'Review this checkout'
      )
    )
  })
})
