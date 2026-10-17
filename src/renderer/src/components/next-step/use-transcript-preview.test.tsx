// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useTranscriptPreview } from './use-transcript-preview'

const f = vi.hoisted(() => ({
  read: vi.fn(),
  source: {
    sourceKind: 'provider' as 'provider' | 'structured',
    sourceHostId: 'runtime:peer',
    sourceAgent: 'codex',
    sourceSessionId: 'conversation',
    sourceTranscriptPath: '/work/first.jsonl'
  }
}))
vi.mock('@/lib/conversation-fleet-transcript-reader', () => ({
  readConversationFleetTranscript: f.read
}))
vi.mock('@/lib/conversation-fleet-context-source', () => ({ resolveSidebarSource: () => f.source }))

const subject = { kind: 'session' as const, session: {} as SidebarSession }
beforeEach(() => {
  f.read.mockReset()
  f.source.sourceKind = 'provider'
  f.source.sourceTranscriptPath = '/work/first.jsonl'
  f.read.mockResolvedValue({ kind: 'file', file: { size: 100_000 }, messageCount: 5201 })
})
afterEach(cleanup)

it('previews the complete conversation through its owner instead of the 5000-message tail', async () => {
  const { result } = renderHook(() => useTranscriptPreview(subject, true))
  await waitFor(() => expect(result.current.pending).toBe(false))
  expect(result.current.preview).toEqual({ messageCount: 5201, sizeBytes: 100_000 })
  expect(f.read).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'provider',
      hostId: 'runtime:peer',
      sessionId: 'conversation'
    }),
    expect.any(String),
    expect.any(AbortSignal),
    true
  )
})
it('rebuilds a preview when the source kind or transcript path changes', async () => {
  const { rerender } = renderHook(() => useTranscriptPreview(subject, true))
  await waitFor(() => expect(f.read).toHaveBeenCalledTimes(1))
  await act(async () => {
    f.source.sourceKind = 'structured'
    f.source.sourceTranscriptPath = '/work/second.jsonl'
    rerender()
  })
  await waitFor(() => expect(f.read).toHaveBeenCalledTimes(2))
  expect(f.read.mock.lastCall![0]).toMatchObject({
    kind: 'structured',
    transcriptPath: '/work/second.jsonl'
  })
})
it('surfaces incomplete-history refusal without offering a partial preview', async () => {
  f.read.mockRejectedValue(new Error('The full history is incomplete.'))
  const { result } = renderHook(() => useTranscriptPreview(subject, true))
  await waitFor(() => expect(result.current.error).toBe('The full history is incomplete.'))
  expect(result.current.preview).toBeNull()
})
