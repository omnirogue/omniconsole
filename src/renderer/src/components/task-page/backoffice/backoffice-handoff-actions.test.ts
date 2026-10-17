// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readPendingHandoff,
  retainPendingHandoff
} from '@/components/handoffs/handoff-request-memory'
import { completeWorkHandoff } from './backoffice-handoff-completion'
import { archiveWorkHandoff } from './backoffice-handoff-archive'

const api = vi.hoisted(() => ({ get: vi.fn(), respond: vi.fn(), archive: vi.fn() }))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => api }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/session-request-thread', () => ({
  sessionRequestBodyOf: (value: { entries: { body: string }[] }) =>
    value.entries.some((entry) => entry.body === 'session request') ? 'session request' : null
}))
const owner = { scope: 'scope-a', viewer: 'emp_me' }
const threadId = 'hth_one'
const detail = (state = 'open', recipient = 'emp_me', body = '') => ({
  ok: true,
  data: {
    thread: {
      id: threadId,
      state,
      author_employee_id: 'emp_sender',
      recipient_employee_id: recipient
    },
    entries: body ? [{ body }] : [],
    files: [],
    reviews: []
  }
})
const receipt = { ok: true, data: { thread_id: threadId, entry_id: 'hte_done' } }
const archiveReceipt = (archived = true, employeeId = 'emp_me') => ({
  ok: true,
  data: { thread_id: threadId, employee_id: employeeId, archived }
})
const current = () => true
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  api.get.mockResolvedValue(detail())
  api.respond.mockResolvedValue(receipt)
  api.archive.mockResolvedValue(archiveReceipt())
})

describe('confirmed handoff completion', () => {
  it('saves the done operation before sending and confirms resolved with a read', async () => {
    api.get.mockResolvedValueOnce(detail()).mockResolvedValueOnce(detail('resolved'))
    api.respond.mockImplementation(async (body) => {
      expect(readPendingHandoff(owner.scope, `reply:${threadId}`)).toEqual({
        kind: 'respond',
        body
      })
      return receipt
    })
    expect(await completeWorkHandoff(threadId, owner, current)).toMatchObject({ ok: true })
    expect(api.respond).toHaveBeenCalledWith(expect.objectContaining({ threadId, kind: 'done' }))
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(readPendingHandoff(owner.scope, `reply:${threadId}`)).toBeNull()
  })

  it('keeps the same operation across uncertain transport and a retry', async () => {
    api.respond.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue(receipt)
    await expect(completeWorkHandoff(threadId, owner, current)).rejects.toThrow('Connection lost')
    const saved = readPendingHandoff(owner.scope, `reply:${threadId}`)
    api.get.mockResolvedValueOnce(detail()).mockResolvedValueOnce(detail('resolved'))
    expect(await completeWorkHandoff(threadId, owner, current)).toMatchObject({ ok: true })
    expect(api.respond.mock.calls[0]?.[0]).toEqual(saved?.body)
    expect(api.respond.mock.calls[1]?.[0]).toEqual(saved?.body)
  })

  it('does not claim complete when pending requests leave a successful done entry open', async () => {
    const result = await completeWorkHandoff(threadId, owner, current)
    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('outstanding requests')
    expect(readPendingHandoff(owner.scope, `reply:${threadId}`)).toBeNull()
  })

  it('retains the operation if the confirmation read fails', async () => {
    api.get.mockResolvedValueOnce(detail()).mockRejectedValueOnce(new Error('Read unavailable'))
    await expect(completeWorkHandoff(threadId, owner, current)).rejects.toThrow('Read unavailable')
    expect(readPendingHandoff(owner.scope, `reply:${threadId}`)?.body).toMatchObject({
      kind: 'done'
    })
  })

  it('treats an already resolved thread as a verified no-op', async () => {
    api.get.mockResolvedValue(detail('resolved'))
    expect(await completeWorkHandoff(threadId, owner, current)).toMatchObject({ ok: true })
    expect(api.respond).not.toHaveBeenCalled()
  })

  it('refuses a session request without transferring any work', async () => {
    api.get.mockResolvedValue(detail('open', 'emp_me', 'session request'))
    await expect(completeWorkHandoff(threadId, owner, current)).rejects.toThrow(
      'Open this session request'
    )
    expect(api.respond).not.toHaveBeenCalled()
  })

  it('preserves a different pending reply for the detail reply UI', async () => {
    const saved = {
      kind: 'respond' as const,
      body: {
        threadId,
        kind: 'reply' as const,
        note: 'My response',
        operationId: 'original-operation'
      }
    }
    retainPendingHandoff(owner.scope, `reply:${threadId}`, saved)
    await expect(completeWorkHandoff(threadId, owner, current)).rejects.toThrow(
      'saved action first'
    )
    expect(readPendingHandoff(owner.scope, `reply:${threadId}`)).toEqual(saved)
    expect(api.respond).not.toHaveBeenCalled()
  })

  it('allows the original sender to finish their sent handoff', async () => {
    api.get.mockResolvedValueOnce(detail()).mockResolvedValueOnce(detail('resolved'))
    expect(
      await completeWorkHandoff(threadId, { ...owner, viewer: 'emp_sender' }, current)
    ).toMatchObject({ ok: true })
  })

  it('refuses another account’s or a mismatched thread before mutation', async () => {
    await expect(
      completeWorkHandoff(threadId, { ...owner, viewer: 'emp_stranger' }, current)
    ).rejects.toThrow('current account')
    await expect(completeWorkHandoff('hth_wrong', owner, current)).rejects.toThrow(
      'current account'
    )
    expect(api.respond).not.toHaveBeenCalled()
  })

  it('stops before writing if the account changes during the detail read', async () => {
    let active = true
    api.get.mockImplementation(async () => {
      active = false
      return detail()
    })
    await expect(completeWorkHandoff(threadId, owner, () => active)).rejects.toThrow(
      'account changed'
    )
    expect(api.respond).not.toHaveBeenCalled()
  })

  it('does not read as a replacement account after the done write', async () => {
    let active = true
    api.respond.mockImplementation(async () => {
      active = false
      return receipt
    })
    await expect(completeWorkHandoff(threadId, owner, () => active)).rejects.toThrow(
      'account changed'
    )
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(readPendingHandoff(owner.scope, `reply:${threadId}`)).not.toBeNull()
  })

  it('rejects the wrong completion receipt and retains its saved operation', async () => {
    api.respond.mockResolvedValue({ ok: true, data: { thread_id: 'hth_else' } })
    await expect(completeWorkHandoff(threadId, owner, current)).rejects.toThrow('not confirmed')
    expect(readPendingHandoff(owner.scope, `reply:${threadId}`)).not.toBeNull()
  })
})

describe('personal handoff archive and restore', () => {
  it('archives without completing and verifies the exact person receipt', async () => {
    expect(await archiveWorkHandoff(threadId, true, owner, current)).toEqual({
      ok: true,
      message: 'Archived for you.'
    })
    expect(api.archive).toHaveBeenCalledWith(expect.objectContaining({ threadId, archived: true }))
    expect(api.respond).not.toHaveBeenCalled()
    expect(readPendingHandoff(owner.scope, `archive:${threadId}`)).toBeNull()
  })

  it('retains an uncertain archive and reuses the original key', async () => {
    api.archive.mockRejectedValueOnce(new Error('Timeout'))
    await expect(archiveWorkHandoff(threadId, true, owner, current)).rejects.toThrow('Timeout')
    const saved = readPendingHandoff(owner.scope, `archive:${threadId}`)
    await archiveWorkHandoff(threadId, true, owner, current)
    expect(api.archive.mock.calls[1]?.[0]).toEqual(saved?.body)
    expect(readPendingHandoff(owner.scope, `archive:${threadId}`)).toBeNull()
  })

  it('reconciles a lost archive receipt before the user restores from Archived', async () => {
    api.archive.mockRejectedValueOnce(new Error('Timeout'))
    await expect(archiveWorkHandoff(threadId, true, owner, current)).rejects.toThrow('Timeout')
    const saved = readPendingHandoff(owner.scope, `archive:${threadId}`)
    api.archive.mockImplementation(async (body) => archiveReceipt(body.archived))
    expect(await archiveWorkHandoff(threadId, false, owner, current)).toMatchObject({ ok: true })
    expect(api.archive.mock.calls[1]?.[0]).toEqual(saved?.body)
    expect(api.archive.mock.calls[2]?.[0]).toMatchObject({ archived: false })
    expect(api.archive.mock.calls[2]?.[0].operationId).not.toBe(saved?.body.operationId)
    expect(readPendingHandoff(owner.scope, `archive:${threadId}`)).toBeNull()
  })

  it('does not reverse an archive whose reconciliation still fails', async () => {
    api.archive.mockRejectedValue(new Error('Timeout'))
    await expect(archiveWorkHandoff(threadId, true, owner, current)).rejects.toThrow('Timeout')
    const saved = readPendingHandoff(owner.scope, `archive:${threadId}`)
    await expect(archiveWorkHandoff(threadId, false, owner, current)).rejects.toThrow('Timeout')
    expect(api.archive.mock.calls.every(([body]) => body.archived === true)).toBe(true)
    expect(readPendingHandoff(owner.scope, `archive:${threadId}`)).toEqual(saved)
  })

  it('stops a reversal if the account changes during original-operation reconciliation', async () => {
    api.archive.mockRejectedValueOnce(new Error('Timeout'))
    await expect(archiveWorkHandoff(threadId, true, owner, current)).rejects.toThrow('Timeout')
    let active = true
    api.archive.mockImplementation(async () => {
      active = false
      return archiveReceipt(true)
    })
    await expect(archiveWorkHandoff(threadId, false, owner, () => active)).rejects.toThrow(
      'account changed'
    )
    expect(api.archive).toHaveBeenCalledTimes(2)
    expect(api.archive.mock.calls.every(([body]) => body.archived === true)).toBe(true)
  })

  it('restores through the same per-person operation', async () => {
    api.archive.mockResolvedValue(archiveReceipt(false))
    expect(await archiveWorkHandoff(threadId, false, owner, current)).toMatchObject({ ok: true })
    expect(api.archive).toHaveBeenCalledWith(expect.objectContaining({ threadId, archived: false }))
  })

  it('rejects another employee’s receipt without clearing the saved request', async () => {
    api.archive.mockResolvedValue(archiveReceipt(true, 'emp_other'))
    await expect(archiveWorkHandoff(threadId, true, owner, current)).rejects.toThrow(
      'not confirmed'
    )
    expect(readPendingHandoff(owner.scope, `archive:${threadId}`)).not.toBeNull()
  })

  it('reports resurfaced content as visible, releases the acknowledged key and permits a fresh decision', async () => {
    api.archive.mockResolvedValueOnce({
      ok: true,
      data: { ...archiveReceipt(false).data, replayed: true }
    })
    const result = await archiveWorkHandoff(threadId, true, owner, current)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('new activity')
    expect(readPendingHandoff(owner.scope, `archive:${threadId}`)).toBeNull()
    await archiveWorkHandoff(threadId, true, owner, current)
    expect(api.archive.mock.calls[0]?.[0].operationId).not.toBe(
      api.archive.mock.calls[1]?.[0].operationId
    )
  })

  it('isolates retry metadata across accounts', async () => {
    api.archive.mockRejectedValue(new Error('Timeout'))
    await expect(archiveWorkHandoff(threadId, true, owner, current)).rejects.toThrow('Timeout')
    expect(readPendingHandoff('scope-b', `archive:${threadId}`)).toBeNull()
  })
})
