// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PeerReceiverDiagnostics } from './PeerReceiverDiagnostics'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, text: string) => text }))
beforeEach(() => {
  rpc.mockReset().mockResolvedValueOnce({
    terminals: [{ handle: 't_1', title: 'My agent', agentIdentity: 'codex', worktreePath: '/work' }]
  })
})
afterEach(cleanup)
async function inspect() {
  render(<PeerReceiverDiagnostics />)
  expect(rpc).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'AI receiving status' }))
  fireEvent.keyDown(await screen.findByRole('combobox'), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: /My agent/ }))
}
it('inspects without sending, binding or acknowledging a message', async () => {
  rpc.mockResolvedValueOnce({
    receiver: { phase: 'awaiting-completion', pending: { pending: 2 }, lastPendingCheckAt: 1000 }
  })
  await inspect()
  expect(
    await screen.findByText('Native hint queued; model completion pending')
  ).toBeInTheDocument()
  expect(screen.getByText(/does not prove that the model read/)).toBeInTheDocument()
  expect(rpc.mock.calls.map((call) => call[1])).toEqual([
    'terminal.list',
    'terminal.peerInboxStatus'
  ])
})
it('does not interpret an older unavailable runtime as an idle or healthy receiver', async () => {
  rpc.mockRejectedValueOnce(new Error('method_not_found'))
  await inspect()
  expect(await screen.findByRole('alert')).toHaveTextContent('Receiving state unavailable')
  expect(screen.queryByText('Listening for pending work')).not.toBeInTheDocument()
})
it('explains an unbound conversation without enrolling a replacement', async () => {
  rpc.mockResolvedValueOnce({ receiver: null })
  await inspect()
  expect(await screen.findByText('No automatic receiver is attached')).toBeInTheDocument()
  expect(rpc).toHaveBeenCalledTimes(2)
})
