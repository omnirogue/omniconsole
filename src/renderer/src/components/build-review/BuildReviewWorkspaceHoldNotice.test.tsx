// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BuildReviewWorkspaceHoldItem } from '../../../../shared/build-review-pipeline'
import { BuildReviewWorkspaceHoldNotice } from './BuildReviewWorkspaceHoldNotice'
import { pipelineFixture } from './build-review-test-fixture'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, english: string) => english
}))
const mocks = vi.hoisted(() => ({ open: vi.fn(async (_handle: string) => undefined) }))
vi.mock('./open-worker-terminal', () => ({ openWorkerTerminal: mocks.open }))

afterEach(cleanup)

function item(
  kind: BuildReviewWorkspaceHoldItem['kind'],
  terminalHandle: string | null = null,
  releasable = false
): BuildReviewWorkspaceHoldItem {
  return {
    kind,
    role: 'builder',
    dispatchId: terminalHandle ? 'ctx_1' : null,
    terminalHandle,
    ...(releasable ? { releasable: true } : {})
  }
}

function renderHold(items: BuildReviewWorkspaceHoldItem[], onRelease = vi.fn()) {
  const pipeline = pipelineFixture({
    stage: 'failed',
    pendingQuestion: null,
    workspaceHold: { pipelineId: 'pipeline-1', runId: 'run_1', items }
  })
  render(
    <BuildReviewWorkspaceHoldNotice pipeline={pipeline} pending={false} onRelease={onRelease} />
  )
  return screen.getByRole('region', { name: 'Workspace still reserved' })
}

describe('BuildReviewWorkspaceHoldNotice', () => {
  it('says an agent may still be working and lets the person open its terminal, with no Release that could not close it', () => {
    const hold = renderHold([item('maybe-working', 'term_builder')])
    expect(hold).toHaveTextContent('An agent from that run may still be working in its terminal.')
    expect(within(hold).getByRole('button', { name: 'Open terminal' })).toBeEnabled()
    expect(within(hold).queryByRole('button', { name: 'Release workspace' })).toBeNull()
    expect(hold).not.toHaveTextContent('OmniConsole cannot confirm')
  })

  it('offers Release only for a terminal the run still owns', () => {
    const onRelease = vi.fn()
    const owned = renderHold([item('terminal-open', 'term_builder', true)], onRelease)
    expect(owned).not.toHaveTextContent('Close it to free the workspace.')
    fireEvent.click(within(owned).getByRole('button', { name: 'Release workspace' }))
    expect(onRelease).toHaveBeenCalledTimes(1)
    cleanup()
    // A failed start's terminal was never the run's to close: closing it is the way out.
    const leftOver = renderHold([item('terminal-open', 'term_builder')])
    expect(leftOver).toHaveTextContent("The builder's terminal is still open.")
    expect(leftOver).toHaveTextContent('Close it to free the workspace.')
    expect(within(leftOver).queryByRole('button', { name: 'Release workspace' })).toBeNull()
    expect(within(leftOver).getByRole('button', { name: 'Open terminal' })).toBeEnabled()
    expect(leftOver).not.toHaveTextContent('OmniConsole cannot confirm')
  })

  it('says so when the terminal it names cannot be opened any more', async () => {
    mocks.open.mockRejectedValueOnce(new Error('terminal_handle_stale'))
    const hold = renderHold([item('terminal-open', 'term_builder')])
    fireEvent.click(within(hold).getByRole('button', { name: 'Open terminal' }))
    expect(await within(hold).findByText('That terminal is closed.')).toBeInTheDocument()
    expect(mocks.open).toHaveBeenCalledWith('term_builder')
  })

  it('offers no Release that can never work, and says why in words', () => {
    const hold = renderHold([item('unverified'), item('worker-running')])
    expect(within(hold).queryByRole('button', { name: 'Release workspace' })).toBeNull()
    expect(hold).toHaveTextContent(
      'OmniConsole cannot confirm that this part of that run has stopped'
    )
  })

  it('leaves a run that is still going, or another window, to itself', () => {
    const hold = renderHold([item('other-window'), item('terminal-open', 'term_builder')])
    expect(within(hold).queryByRole('button', { name: 'Release workspace' })).toBeNull()
    expect(hold).not.toHaveTextContent('OmniConsole cannot confirm')
  })
})
