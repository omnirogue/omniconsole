// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem } from '../../../../shared/artifacts'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))

import { ArtifactDetailMeta } from './ArtifactDetailMeta'

const item: ArtifactListItem = {
  artifact: {
    version: 1,
    slug: 'a',
    title: 'Plan',
    originalFileName: null,
    sourceContentType: 'text/html',
    renderedContentType: 'text/html',
    createdAt: '',
    updatedAt: '2026-09-02T00:00:00Z',
    expiresAt: '',
    byteSize: 1,
    deletedAt: null,
    revision: 5,
    review: { question: 'Ship?', reviewers: [], status: 'pending', statusAt: null },
    lifecycle: null,
    closedAt: null,
    closedRef: null,
    supersededBy: null,
    supersededAt: null
  },
  shareUrl: 'https://omnios.example/a/a',
  needsYou: true,
  lastDecision: null
}

const decided = {
  status: 'ok',
  value: {
    artifact: item.artifact,
    shareUrl: item.shareUrl,
    status: 'approved',
    latest: null,
    decisions: [
      {
        id: 'd1',
        revision: 5,
        decision: 'approved',
        comment: '',
        edits: null,
        by: { email: 'sal@example.com', name: 'Sal' },
        at: '2026-09-27T10:00:00Z'
      }
    ],
    viewer: { signedIn: true, isOwner: true, canDecide: true }
  }
}

function renderMeta(): void {
  render(
    <ArtifactDetailMeta
      item={item}
      sessionTitle={null}
      successorTitle={null}
      onOpenSuccessor={vi.fn()}
      onOpenSession={vi.fn()}
    />
  )
}

describe('ArtifactDetailMeta', () => {
  afterEach(() => {
    cleanup()
    rpc.mockReset()
  })

  it('R4: says a failed decisions read is unavailable, and Retry reads again', async () => {
    rpc.mockRejectedValueOnce(new Error('timed out')).mockResolvedValueOnce(decided)
    renderMeta()
    expect(await screen.findByText(/^Decision history unavailable/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/Decisions: approved rev 5 \(Sal/)).toBeInTheDocument()
    expect(screen.queryByText(/^Decision history unavailable/)).toBeNull()
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('shows nothing for an empty history that read fine', async () => {
    rpc.mockResolvedValue({ ...decided, value: { ...decided.value, decisions: [] } })
    renderMeta()
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/^Decision history unavailable/)).toBeNull()
    expect(screen.queryByText(/Decisions:/)).toBeNull()
  })
})
