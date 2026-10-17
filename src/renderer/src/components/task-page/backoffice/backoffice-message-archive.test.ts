// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { readPendingHandoff } from '@/components/handoffs/handoff-request-memory'
import { archiveWorkMessage } from './backoffice-message-archive'

const api = vi.hoisted(() => ({ archiveMessage: vi.fn() }))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => api }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const owner = { scope: 'scope-a', viewer: 'emp_me' }
const messageId = `pm_${'a'.repeat(24)}`
const target = `peer-archive:${messageId}`
const current = () => true
const receipt = (archived = true) => ({
  ok: true,
  data: { message_id: messageId, employee_id: owner.viewer, archived }
})
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  api.archiveMessage.mockResolvedValue(receipt())
})

it('retains the original operation across timeout and retry', async () => {
  api.archiveMessage.mockRejectedValueOnce(new Error('Timeout'))
  await expect(archiveWorkMessage(messageId, true, owner, current)).rejects.toThrow('Timeout')
  const saved = readPendingHandoff(owner.scope, target)
  expect(saved?.kind).toBe('peer-archive')
  expect(readPendingHandoff('scope-b', target)).toBeNull()
  expect(await archiveWorkMessage(messageId, true, owner, current)).toMatchObject({ ok: true })
  expect(api.archiveMessage.mock.calls[1]?.[0]).toEqual(saved?.body)
  expect(readPendingHandoff(owner.scope, target)).toBeNull()
})

it('recovers the lost Delete receipt before saving a new Restore operation', async () => {
  api.archiveMessage.mockRejectedValueOnce(new Error('Timeout'))
  await expect(archiveWorkMessage(messageId, true, owner, current)).rejects.toThrow('Timeout')
  const saved = readPendingHandoff(owner.scope, target)
  api.archiveMessage.mockImplementation(async (body) => receipt(body.archived))
  expect(await archiveWorkMessage(messageId, false, owner, current)).toMatchObject({ ok: true })
  expect(api.archiveMessage.mock.calls[1]?.[0]).toEqual(saved?.body)
  expect(api.archiveMessage.mock.calls[2]?.[0]).toMatchObject({ archived: false })
  expect(api.archiveMessage.mock.calls[2]?.[0].operationId).not.toBe(saved?.body.operationId)
})

it('keeps the pending operation if another account receives its response', async () => {
  let active = true
  api.archiveMessage.mockImplementation(async () => {
    active = false
    return receipt()
  })
  await expect(archiveWorkMessage(messageId, true, owner, () => active)).rejects.toThrow(
    'account changed'
  )
  expect(readPendingHandoff(owner.scope, target)).not.toBeNull()
})

it('retains metadata after a receipt names another employee', async () => {
  api.archiveMessage.mockResolvedValue({
    ok: true,
    data: { ...receipt().data, employee_id: 'emp_other' }
  })
  await expect(archiveWorkMessage(messageId, true, owner, current)).rejects.toThrow('not confirmed')
  expect(readPendingHandoff(owner.scope, target)).not.toBeNull()
})

it('surfaces new activity and allows a fresh explicit Delete', async () => {
  api.archiveMessage.mockResolvedValueOnce(receipt(false))
  expect(await archiveWorkMessage(messageId, true, owner, current)).toMatchObject({ ok: false })
  expect(readPendingHandoff(owner.scope, target)).toBeNull()
  await archiveWorkMessage(messageId, true, owner, current)
  expect(api.archiveMessage.mock.calls[1]?.[0].operationId).not.toBe(
    api.archiveMessage.mock.calls[0]?.[0].operationId
  )
})
