import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../backoffice/console-workflow-person', () => ({ captureConsoleWorkflowPerson: vi.fn() }))
vi.mock('../backoffice/console-workflow-transport', () => ({
  requestConsoleWorkflow: vi.fn(),
  failure: (code: string, message: string) => ({ ok: false, error: { code, message } })
}))
import { CustomerServiceLaunchStore } from './launch-store'
import { CustomerServiceLaunchService } from './launch-service'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import type { CustomerServiceLaunch } from '../../shared/customer-service-launch'

const id = `csl_${'a'.repeat(32)}`
const ledger = `als_${'a'.repeat(24)}`
let directory: string
let current: boolean
let principal: string
let response: CustomerServiceLaunch
let store: CustomerServiceLaunchStore
const localSessions = vi.fn()
function service() {
  return new CustomerServiceLaunchService({ store, localSessions })
}
async function preview(client: CustomerServiceLaunchService) {
  const result = await client.preview(id)
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return result.data
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cs-launch-'))
  store = new CustomerServiceLaunchStore(directory)
  current = true
  principal = 'person-a'
  response = {
    launch_id: id,
    status: 'prepared',
    company: { slug: 'omnirogue', name: 'OmniRogue' },
    brief: 'Resolve selected issues with their existing support policy.',
    ticket_ids: [1, 2],
    claim_id: null,
    session_ledger_id: null
  }
  localSessions.mockReturnValue([])
  vi.mocked(captureConsoleWorkflowPerson).mockImplementation(async () => ({
    ok: true,
    data: {
      baseUrl: 'https://app.omnisi.ai',
      bearer: 'odt_test',
      principal,
      profileKey: 'profile-a',
      isCurrent: () => current
    }
  }))
  vi.mocked(requestConsoleWorkflow).mockImplementation(async (path, method, _schema, body) => {
    if (method === 'POST' && path.endsWith('/claim')) {
      const claim = (body as { claim_id: string }).claim_id
      if (response.claim_id && response.claim_id !== claim) {
        return { ok: false, error: { code: 'claimed', message: 'Claimed elsewhere' } }
      }
      response = { ...response, status: 'claimed', claim_id: claim }
    }
    if (path.endsWith('/receipt')) {
      response = {
        ...response,
        status: 'launched',
        session_ledger_id: (body as { session_ledger_id: string }).session_ledger_id
      }
    }
    return { ok: true, data: response } as never
  })
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('identity-bound native Customer Service launches', () => {
  it('uses only the authenticated owner GET and does not claim from the protocol preview', async () => {
    const shown = await preview(service())
    expect(shown.localState).toBe('ready')
    expect(requestConsoleWorkflow).toHaveBeenCalledExactlyOnceWith(
      `/api/customer-service/session-launches/${id}`,
      'GET',
      expect.anything(),
      undefined,
      15000,
      true,
      'person-a',
      expect.any(Function)
    )
  })
  it('refuses cross-account confirmation before any claim', async () => {
    const client = service()
    const shown = await preview(client)
    current = false
    expect(await client.begin({ previewKey: shown.previewKey })).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
    expect(requestConsoleWorkflow).toHaveBeenCalledTimes(1)
  })
  it('persists the consumed permit and never repeats launch after a process restart', async () => {
    const client = service()
    const shown = await preview(client)
    expect(await client.begin({ previewKey: shown.previewKey })).toMatchObject({ ok: true })
    expect(await client.begin({ previewKey: shown.previewKey })).toMatchObject({
      ok: false,
      error: { code: 'launch_unverifiable' }
    })
    const restarted = service()
    const again = await preview(restarted)
    expect(again.localState).toBe('unverifiable')
    expect(await restarted.begin({ previewKey: again.previewKey })).toMatchObject({ ok: false })
    expect(
      vi.mocked(requestConsoleWorkflow).mock.calls.filter((call) => call[1] === 'POST')
    ).toHaveLength(1)
  })
  it('serializes duplicate confirmations while the claim is in flight', async () => {
    const client = service()
    const shown = await preview(client)
    const first = client.begin({ previewKey: shown.previewKey })
    expect(await client.begin({ previewKey: shown.previewKey })).toMatchObject({
      ok: false,
      error: { code: 'launch_busy' }
    })
    expect(await first).toMatchObject({ ok: true })
  })
  it('refuses a changed brief after the person confirmed the preview', async () => {
    const client = service()
    const shown = await preview(client)
    response = { ...response, brief: 'Different work that the person did not confirm.' }
    expect(await client.begin({ previewKey: shown.previewKey })).toMatchObject({
      ok: false,
      error: { code: 'launch_unverifiable' }
    })
  })
  it('retries a lost claim reply with the original claim, without resetting identity', async () => {
    const client = service()
    const shown = await preview(client)
    const implementation = vi.mocked(requestConsoleWorkflow).getMockImplementation()!
    let original: string | undefined
    vi.mocked(requestConsoleWorkflow).mockImplementationOnce(async (...args) => {
      original = (args[3] as { claim_id: string }).claim_id
      await implementation(...args)
      return { ok: false, error: { code: 'backoffice_unavailable', message: 'Lost reply' } }
    })
    expect(await client.begin({ previewKey: shown.previewKey })).toMatchObject({ ok: false })
    const restarted = service()
    const again = await preview(restarted)
    expect(again.localState).toBe('ready')
    const result = await restarted.begin({ previewKey: again.previewKey })
    expect(result).toMatchObject({ ok: true, data: { claim_id: original } })
  })
  it('refuses a claim held on another computer', async () => {
    response.claim_id = '11111111-1111-4111-8111-111111111111'
    response.status = 'claimed'
    const client = service()
    const shown = await preview(client)
    expect(shown.localState).toBe('unverifiable')
    expect(await client.begin({ previewKey: shown.previewKey })).toMatchObject({ ok: false })
  })
  it('derives receipts from the exact local pane, retains pending state, and retries without launching', async () => {
    const client = service()
    const shown = await preview(client)
    await client.begin({ previewKey: shown.previewKey })
    localSessions.mockReturnValue([{ paneId: 'other-tab:pane', ledgerId: ledger }])
    expect(await client.receipt({ previewKey: shown.previewKey, tabId: 'new-tab' })).toMatchObject({
      ok: false,
      error: { code: 'receipt_pending' }
    })
    const restarted = service()
    const again = await preview(restarted)
    expect(again.localState).toBe('receipt-pending')
    expect(
      await restarted.receipt({ previewKey: again.previewKey, tabId: 'other-tab' })
    ).toMatchObject({ ok: false })
    localSessions.mockReturnValue([{ paneId: 'new-tab:pane', ledgerId: ledger }])
    expect(await restarted.receipt({ previewKey: again.previewKey })).toMatchObject({
      ok: true,
      data: { status: 'launched', session_ledger_id: ledger }
    })
    expect(
      vi.mocked(requestConsoleWorkflow).mock.calls.filter((call) => call[0].endsWith('/claim'))
    ).toHaveLength(1)
  })
  it('refuses execution when durable storage fails', async () => {
    const client = service()
    const shown = await preview(client)
    vi.spyOn(store, 'write').mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(await client.begin({ previewKey: shown.previewKey })).toMatchObject({
      ok: false,
      error: { code: 'launch_journal_unavailable' }
    })
    expect(requestConsoleWorkflow).toHaveBeenCalledTimes(1)
  })
})
