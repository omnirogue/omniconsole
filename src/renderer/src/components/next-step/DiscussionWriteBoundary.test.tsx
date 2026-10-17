// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DiscussionWriteBoundary } from './DiscussionWriteBoundary'
const read = vi.hoisted(() => vi.fn())
vi.mock('@/lib/console-workflow-client', () => ({
  consoleWorkflowApi: () => ({ readCommunicationMode: read }),
  workflowData: (value: { data: unknown }) => value.data,
  workflowErrorMessage: (error: unknown) => String(error)
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
beforeEach(() => read.mockReset())
afterEach(cleanup)
it('does not offer a legacy composer while the authority read is pending or migrated', async () => {
  let resolve!: (value: unknown) => void
  read.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  render(
    <DiscussionWriteBoundary>
      <button>Send legacy message</button>
    </DiscussionWriteBoundary>
  )
  expect(screen.queryByText('Send legacy message')).toBeNull()
  resolve({ data: { mode: 'omniconsole', ready: true, legacyWritesFenced: true } })
  await screen.findByText(/Messaging moved to OmniRogue Chats/)
  expect(screen.queryByText('Send legacy message')).toBeNull()
})
it('recovers an unavailable config only after an explicit recheck', async () => {
  read.mockRejectedValueOnce(new Error('Connection unavailable'))
  render(
    <DiscussionWriteBoundary>
      <button>Send legacy message</button>
    </DiscussionWriteBoundary>
  )
  await screen.findByRole('alert')
  expect(screen.queryByText('Send legacy message')).toBeNull()
  read.mockResolvedValue({ data: { mode: 'legacy', ready: false, legacyWritesFenced: false } })
  fireEvent.click(screen.getByText('Check again'))
  await screen.findByText('Send legacy message')
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
})
