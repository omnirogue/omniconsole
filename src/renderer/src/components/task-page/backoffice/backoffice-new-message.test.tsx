// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackofficeNewMessage } from './backoffice-new-message'
import {
  readHandoffChatView,
  readPendingHandoff
} from '@/components/handoffs/handoff-request-memory'
import { clearNativeChatDraftCacheForTests } from '@/components/native-chat/native-chat-draft-cache'

const mocks = vi.hoisted(() => ({
  scope: 'account-A',
  me: vi.fn(),
  list: vi.fn(),
  recipients: vi.fn(),
  agentRecipients: vi.fn(),
  sendCardless: vi.fn(),
  sendAgent: vi.fn(),
  uploadThreadFile: vi.fn(),
  refresh: vi.fn(),
  onSent: vi.fn(),
  roster: [
    { id: 'emp_sal_test', name: 'Sal Baker' },
    { id: 'emp_uma', name: 'Uma Evans', department: 'Engineering' },
    { id: 'emp_iris', name: 'Iris', department: 'Operations' }
  ]
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      params && name in params ? String(params[name]) : match
    )
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ scope: mocks.scope }) } }))
vi.mock('@/lib/console-account-scope', () => ({
  selectConsoleAccountScope: (state: { scope: string }) => state.scope
}))
vi.mock('@/components/handoffs/handoff-scope', () => ({
  useHandoffScope: () => mocks.scope
}))
vi.mock('@/components/next-step/use-handoff-people', () => ({
  useHandoffPeople: () => ({
    people: { phase: 'ready', value: mocks.roster },
    employeeId: 'emp_sal_test'
  })
}))
vi.mock('@/components/companies/companies-client', () => ({
  companiesApi: () => ({ me: mocks.me })
}))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => mocks }))
vi.mock('@/lib/session-follow-up-io', () => ({
  createFollowUpHubIo: () => ({
    sendCardless: mocks.sendCardless,
    uploadThreadFile: mocks.uploadThreadFile
  })
}))
vi.mock('./backoffice-work-store', () => ({ loadBackofficeWork: mocks.refresh }))

const target = 'chat:work-new-message'

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  mocks.scope = 'account-A'
  mocks.me.mockResolvedValue({
    ok: true,
    data: { ok: true, user: { employee_id: 'emp_sal_test' } }
  })
  mocks.list.mockResolvedValue({ ok: true, data: { assignee: 'emp_sal_test', threads: [] } })
  mocks.recipients.mockResolvedValue({ ok: true, data: { employees: mocks.roster } })
  mocks.sendCardless.mockResolvedValue({ thread_id: 'hth_sent' })
})
afterEach(cleanup)

function openComposer() {
  const view = render(<BackofficeNewMessage onSent={mocks.onSent} />)
  fireEvent.click(screen.getByRole('button', { name: 'New message' }))
  return view
}

function choosePeople(...names: string[]) {
  fireEvent.click(screen.getByRole('combobox', { name: 'To' }))
  for (const name of names) {
    fireEvent.change(screen.getByPlaceholderText('Search teammates…'), { target: { value: name } })
    fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }))
  }
  fireEvent.keyDown(screen.getByPlaceholderText('Search teammates…'), { key: 'Escape' })
}

function chooseType(label: string) {
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Communication type' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: label }))
}

function writeMessage(message: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: message }
  })
}

describe('Work New message uses the existing human chat delivery', () => {
  it.each(['Decision', 'Request', 'Question', 'Plan', 'Information'])(
    'sends a %s to the explicitly selected employee without any agent endpoint',
    async (label) => {
      openComposer()
      expect(
        (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled
      ).toBe(true)
      choosePeople('Uma Evans')
      chooseType(label)
      const message = `Sal, review this when you can.\n${'Full message. '.repeat(90)}https://example.com/plan`
      writeMessage(message)
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      await waitFor(() => expect(mocks.onSent).toHaveBeenCalledOnce())
      expect(mocks.sendCardless).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient: 'emp_uma',
          note: message,
          communicationType: label.toLowerCase(),
          attachments: []
        })
      )
      expect(mocks.agentRecipients).not.toHaveBeenCalled()
      expect(mocks.sendAgent).not.toHaveBeenCalled()
      expect(mocks.refresh).toHaveBeenCalledWith('account-A', { force: true })
      expect(readPendingHandoff('account-A', target)).toBeNull()
      expect(readHandoffChatView('account-A', target).sent[0]).toMatchObject({
        recipients: [{ kind: 'person', id: 'emp_uma', name: 'Uma Evans' }],
        receipts: { 'person:emp_uma': { id: 'hth_sent', kind: 'person' } }
      })
      expect(screen.queryByRole('dialog')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'New message' }))
      expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
        ''
      )
    }
  )

  it('restores the account-scoped draft and selected people after closing', () => {
    openComposer()
    choosePeople('Uma Evans')
    chooseType('Question')
    writeMessage('Can you review the launch?')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    clearNativeChatDraftCacheForTests()
    fireEvent.click(screen.getByRole('button', { name: 'New message' }))
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
      'Can you review the launch?'
    )
    expect(screen.getByRole('combobox', { name: 'To' }).textContent).toContain('Uma Evans')
    expect(screen.getByRole('combobox', { name: 'Communication type' }).textContent).toBe(
      'Question'
    )
    expect(mocks.sendCardless).not.toHaveBeenCalled()
  })

  it('keeps an uncertain send frozen on reopen and reuses its request key', async () => {
    mocks.sendCardless.mockResolvedValueOnce({})
    openComposer()
    choosePeople('Uma Evans')
    chooseType('Request')
    writeMessage('Please review the exact plan.')
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText(/Delivery to Uma Evans is unconfirmed/)
    const firstRequest = mocks.sendCardless.mock.calls[0]![0]
    expect(mocks.onSent).not.toHaveBeenCalled()
    expect(readPendingHandoff('account-A', target)?.kind).toBe('chat')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    clearNativeChatDraftCacheForTests()
    fireEvent.click(screen.getByRole('button', { name: 'New message' }))
    const message = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    expect(message.value).toBe('Please review the exact plan.')
    expect(message.disabled).toBe(true)
    expect((screen.getByRole('combobox', { name: 'To' }) as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByRole('combobox', { name: 'Communication type' }) as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved message' }))
    await waitFor(() => expect(mocks.onSent).toHaveBeenCalledOnce())
    expect(mocks.sendCardless).toHaveBeenCalledTimes(2)
    expect(mocks.sendCardless.mock.calls[1]![0]).toEqual(firstRequest)
  })

  it('retries only the unconfirmed person after a partially delivered message', async () => {
    mocks.sendCardless
      .mockResolvedValueOnce({ thread_id: 'hth_uma' })
      .mockRejectedValueOnce(new Error('Connection lost'))
    openComposer()
    choosePeople('Uma Evans', 'Iris')
    writeMessage('Please review together.')
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Connection lost')
    const pending = readPendingHandoff('account-A', target)
    expect(pending).toMatchObject({
      kind: 'chat',
      body: { receipts: { 'person:emp_uma': { id: 'hth_uma', kind: 'person' } } }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved message' }))
    await waitFor(() => expect(mocks.onSent).toHaveBeenCalledOnce())
    expect(mocks.sendCardless.mock.calls.map(([request]) => request.recipient)).toEqual([
      'emp_uma',
      'emp_iris',
      'emp_iris'
    ])
    expect(mocks.sendCardless.mock.calls[2]![0].operationId).toBe(
      mocks.sendCardless.mock.calls[1]![0].operationId
    )
  })

  it('retains the editable draft when the signed identity and handoff identity differ', async () => {
    mocks.list.mockResolvedValue({ ok: true, data: { assignee: 'emp_wrong', threads: [] } })
    openComposer()
    choosePeople('Uma Evans')
    writeMessage('Keep this draft.')
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText(/Your sign-in and handoff account do not match/)
    expect(mocks.sendCardless).not.toHaveBeenCalled()
    expect(mocks.onSent).not.toHaveBeenCalled()
    expect(readPendingHandoff('account-A', target)).toBeNull()
    const message = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    expect(message.value).toBe('Keep this draft.')
    expect(message.disabled).toBe(false)
  })

  it('isolates saved drafts when the signed account changes', () => {
    const view = openComposer()
    choosePeople('Uma Evans')
    writeMessage('Only account A can send this.')
    mocks.scope = 'account-B'
    view.rerender(<BackofficeNewMessage onSent={mocks.onSent} />)
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByRole('combobox', { name: 'To' }).textContent).toBe('Choose people')
    mocks.scope = 'account-A'
    view.rerender(<BackofficeNewMessage onSent={mocks.onSent} />)
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
      'Only account A can send this.'
    )
    expect(screen.getByRole('combobox', { name: 'To' }).textContent).toContain('Uma Evans')
    expect(mocks.sendCardless).not.toHaveBeenCalled()
  })

  it('keeps oversized text editable so the person can correct it before sending', async () => {
    openComposer()
    choosePeople('Uma Evans')
    writeMessage('x'.repeat(8193))
    expect(screen.getByRole('alert').textContent).toBe(
      'Messages can contain up to 8,192 characters.'
    )
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(
      false
    )
    expect(
      (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled
    ).toBe(true)
    writeMessage('Please review.')
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(mocks.onSent).toHaveBeenCalledOnce())
    expect(mocks.sendCardless).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'Please review.' })
    )
  })
})
