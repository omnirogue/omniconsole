// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InboxCompose } from './InboxCompose'
import { useInboxPeople } from './use-inbox-people'
import { readPendingHandoff } from '@/components/handoffs/handoff-request-memory'

const account = vi.hoisted(() => ({ scope: 'account-A' }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ scope: account.scope }) } }))
vi.mock('@/lib/console-account-scope', () => ({
  selectConsoleAccountScope: (state: { scope: string }) => state.scope
}))
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => account.scope }))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, text: string) => text }))
vi.mock('./InboxRoomCompose', () => ({
  InboxRoomCompose: ({ project }: { project: string }) => (
    <div data-testid="room-compose">{project}</div>
  )
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
    disabled
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
    disabled?: boolean
  }) => (
    <select
      aria-label="To"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      <option value="">—</option>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))
afterEach(cleanup)

const SAL = { employee_id: 'emp_sal', name: 'Sal', enrolled: false }
const inboxSend = vi.fn()
const feed = vi.fn()
const target = 'peer:inbox:compose'
beforeEach(() => {
  localStorage.clear()
  account.scope = 'account-A'
  inboxSend.mockReset()
  feed.mockReset()
  ;(window as unknown as { api: unknown }).api = { backoffice: { inboxSend, feed } }
})

it('sends a plain message to a person directly, then reports it and closes', async () => {
  inboxSend.mockResolvedValue({ ok: true, body: { message: { id: 'msg_1' } } })
  const close = vi.fn()
  const onSent = vi.fn()
  render(<InboxCompose people={[SAL]} close={close} onSent={onSent} />)
  fireEvent.change(screen.getByLabelText('To'), { target: { value: 'emp_sal' } })
  fireEvent.change(screen.getByLabelText('Message'), {
    target: { value: 'Did you get the handoff?' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(onSent).toHaveBeenCalledWith(SAL))
  expect(inboxSend).toHaveBeenCalledTimes(1)
  const args = inboxSend.mock.calls[0][0]
  expect(args).toMatchObject({
    to: 'emp_sal',
    text: 'Did you get the handoff?',
    purpose: 'question'
  })
  expect(args.idempotencyKey).toMatch(/^omnios-inbox-[0-9a-f-]{36}$/)
  expect(close).toHaveBeenCalled()
})

it('shows the hub refusal in the hub’s own words and keeps the draft', async () => {
  inboxSend.mockResolvedValue({
    ok: false,
    message: "'emp_sal' has a pending console account — an admin approves it in Admin → Users"
  })
  render(
    <InboxCompose
      kind="message"
      project="proj_1"
      people={[SAL]}
      close={vi.fn()}
      prepare={vi.fn()}
    />
  )
  fireEvent.change(screen.getByLabelText('To'), { target: { value: 'emp_sal' } })
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('pending console account')
  )
  expect(screen.getByLabelText('Message')).toHaveValue('hi')
})

it('refuses to send without a recipient and never calls the backoffice', () => {
  render(
    <InboxCompose
      kind="message"
      project="proj_1"
      people={[SAL]}
      close={vi.fn()}
      prepare={vi.fn()}
    />
  )
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Choose a colleague')
  expect(inboxSend).not.toHaveBeenCalled()
})

it('opens the session and task room composer for rooms', () => {
  const prepare = vi.fn()
  render(<InboxCompose kind="room" project="proj_1" close={vi.fn()} prepare={prepare} />)
  expect(screen.getByTestId('room-compose')).toHaveTextContent('proj_1')
  expect(screen.queryByLabelText('Existing task ID')).not.toBeInTheDocument()
  expect(inboxSend).not.toHaveBeenCalled()
})

it('freezes an uncertain draft and recovers its original retry key after closing', async () => {
  inboxSend.mockResolvedValue({ ok: false, message: 'Connection interrupted' })
  const view = render(
    <InboxCompose
      kind="message"
      project="proj_1"
      people={[SAL]}
      close={vi.fn()}
      prepare={vi.fn()}
    />
  )
  fireEvent.change(screen.getByLabelText('To'), { target: { value: 'emp_sal' } })
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'First message' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry message' })).toBeEnabled())
  expect(screen.getByLabelText('Message')).toBeDisabled()
  expect(screen.getByLabelText('To')).toBeDisabled()
  expect(readPendingHandoff('account-A', target)).toMatchObject({
    kind: 'peer-send',
    body: { to: 'emp_sal', text: 'First message' }
  })
  view.unmount()
  render(
    <InboxCompose
      kind="message"
      project="proj_1"
      people={[SAL]}
      close={vi.fn()}
      prepare={vi.fn()}
    />
  )
  expect(screen.getByLabelText('Message')).toHaveValue('First message')
  expect(screen.getByLabelText('To')).toHaveValue('emp_sal')
  fireEvent.click(screen.getByRole('button', { name: 'Retry message' }))
  await waitFor(() => expect(inboxSend).toHaveBeenCalledTimes(2))
  expect(inboxSend.mock.calls[1][0].idempotencyKey).toBe(inboxSend.mock.calls[0][0].idempotencyKey)
  expect(inboxSend.mock.calls[1][0]).toEqual(inboxSend.mock.calls[0][0])
})

it('does not clear or report an old account message when success arrives after switching', async () => {
  let finish!: (value: unknown) => void
  inboxSend.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const close = vi.fn()
  const onSent = vi.fn()
  const props = {
    kind: 'message' as const,
    project: 'proj_1',
    people: [SAL],
    close,
    onSent,
    prepare: vi.fn()
  }
  const view = render(<InboxCompose {...props} />)
  fireEvent.change(screen.getByLabelText('To'), { target: { value: 'emp_sal' } })
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Private original' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  account.scope = 'account-B'
  view.rerender(<InboxCompose {...props} />)
  await act(async () => {
    finish({ ok: true, body: {} })
  })
  expect(screen.getByLabelText('Message')).toHaveValue('')
  expect(onSent).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  expect(readPendingHandoff('account-A', target)).toMatchObject({ kind: 'peer-send' })
  account.scope = 'account-A'
  view.rerender(<InboxCompose {...props} />)
  expect(screen.getByLabelText('Message')).toHaveValue('Private original')
  expect(screen.getByLabelText('Message')).toBeDisabled()
})

it('blocks delivery if the saved request cannot be persisted', async () => {
  const store = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Storage unavailable')
  })
  try {
    render(
      <InboxCompose
        kind="message"
        project="proj_1"
        people={[SAL]}
        close={vi.fn()}
        prepare={vi.fn()}
      />
    )
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'emp_sal' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Retain this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Storage unavailable')
    expect(inboxSend).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Message')).toHaveValue('Retain this')
  } finally {
    store.mockRestore()
  }
})

it('clears a saved retry only after the main process confirms the receipt', async () => {
  inboxSend
    .mockResolvedValueOnce({ ok: false, code: 'invalid_response', message: 'Unverified recipient' })
    .mockResolvedValueOnce({ ok: true, body: { message: { id: `pm_${'a'.repeat(24)}` } } })
  const onSent = vi.fn()
  render(
    <InboxCompose
      kind="message"
      project="proj_1"
      people={[SAL]}
      close={vi.fn()}
      onSent={onSent}
      prepare={vi.fn()}
    />
  )
  fireEvent.change(screen.getByLabelText('To'), { target: { value: 'emp_sal' } })
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Exact person' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await screen.findByText('Unverified recipient')
  expect(onSent).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry message' }))
  await waitFor(() => expect(onSent).toHaveBeenCalledWith(SAL))
  expect(readPendingHandoff('account-A', target)).toBeNull()
})

it('clears old people immediately on an account change and ignores their late response', async () => {
  let finish!: (value: unknown) => void
  feed
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    .mockResolvedValueOnce({
      ok: true,
      body: { people: [{ ...SAL, employee_id: 'emp_new', name: 'New account colleague' }] }
    })
  const view = renderHook(() => useInboxPeople(0))
  await waitFor(() => expect(feed).toHaveBeenCalledOnce())
  account.scope = 'account-B'
  view.rerender()
  expect(view.result.current.people).toEqual([])
  await waitFor(() => expect(view.result.current.people[0]?.employee_id).toBe('emp_new'))
  await act(async () => {
    finish({ ok: true, body: { people: [SAL] } })
  })
  expect(view.result.current.people.map((person) => person.employee_id)).toEqual(['emp_new'])
})
