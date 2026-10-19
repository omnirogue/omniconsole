// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeliverableVerificationRecord } from '../../../../../shared/deliverable-verification-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))
const state = vi.hoisted(() => ({
  records: [] as DeliverableVerificationRecord[],
  markFalseAlarm: vi.fn()
}))
vi.mock('./use-session-deliverables', () => ({
  useSessionDeliverables: () => ({ records: state.records, markFalseAlarm: state.markFalseAlarm })
}))

import { SessionDeliverables } from './SessionDeliverables'
import { deliverableStatusLine } from './session-deliverables-model'

function record(extra: Partial<DeliverableVerificationRecord> = {}): DeliverableVerificationRecord {
  return {
    id: 'r1',
    paneKey: 'pane',
    worktreeId: 'wt',
    conversationKey: 'c',
    host: 'local',
    turnKey: 't',
    requestId: 'q',
    requestStartedAt: 1,
    checkedAt: 2,
    checks: [
      {
        target: 'docs/plan.md',
        kind: 'file',
        source: 'claim',
        claim: 'created',
        verdict: 'missing',
        detail: 'no file on this computer'
      },
      {
        target: 'docs/spec.md',
        kind: 'file',
        source: 'request',
        claim: 'named',
        verdict: 'verified',
        detail: 'found'
      },
      {
        target: 'https://github.com/o/r/pull/1',
        kind: 'url',
        source: 'claim',
        claim: 'published',
        verdict: 'unverifiable',
        detail: 'links are not checked yet'
      }
    ],
    overall: 'incomplete',
    mode: 'shadow',
    action: 'would-repair',
    repairsSent: 0,
    maxRepairs: 2,
    ...extra
  }
}

describe('SessionDeliverables', () => {
  afterEach(() => {
    cleanup()
    state.records = []
    state.markFalseAlarm.mockClear()
  })

  it('renders nothing without a record', () => {
    const { container } = render(<SessionDeliverables session={null} active />)
    expect(container.innerHTML).toBe('')
  })

  it('shows each item with its verdict, source and reason, and the Watch only status', () => {
    state.records = [record()]
    render(<SessionDeliverables session={null} active />)
    expect(screen.getByText('Missing')).toBeTruthy()
    expect(screen.getByText('Verified')).toBeTruthy()
    expect(screen.getByText("Can't check")).toBeTruthy()
    expect(screen.getByText('reply says created · no file on this computer')).toBeTruthy()
    expect(screen.getByText(/Would ask the agent to finish 1 item/)).toBeTruthy()
    expect(screen.getByText(/checked on this computer/)).toBeTruthy()
  })

  it('marks a false alarm once', () => {
    state.records = [record()]
    render(<SessionDeliverables session={null} active />)
    fireEvent.click(screen.getByRole('button', { name: 'Not a problem' }))
    expect(state.markFalseAlarm).toHaveBeenCalledWith('r1')
    cleanup()
    state.records = [record({ falseAlarmAt: 5 })]
    render(<SessionDeliverables session={null} active />)
    expect(screen.queryByRole('button', { name: 'Not a problem' })).toBeNull()
  })
})

describe('deliverableStatusLine', () => {
  it('names what happened next', () => {
    expect(deliverableStatusLine(record({ action: 'repair-sent', repairsSent: 1 }))).toBe(
      'Asking the agent to finish (1 of 2)'
    )
    expect(deliverableStatusLine(record({ action: 'stopped:no-progress' }))).toBe(
      'Stopped: the last repair changed nothing'
    )
    expect(deliverableStatusLine(record({ action: 'exhausted' }))).toBe(
      '1 deliverables still missing'
    )
    expect(deliverableStatusLine(record({ action: 'skipped:asks-person' }))).toBe(
      '1 missing; not asked (asks person)'
    )
    expect(
      deliverableStatusLine(
        record({ action: 'none', overall: 'complete', checks: record().checks.slice(1, 2) })
      )
    ).toBe('Checked: 1 of 1 found')
  })
})
