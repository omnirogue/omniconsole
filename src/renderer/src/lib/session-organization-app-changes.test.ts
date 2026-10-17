import { describe, expect, it, vi } from 'vitest'
import { setAutomaticArchiveChecks } from './session-automatic-archive-guard'
import {
  applyRecordedChange,
  autoArchiveChange,
  finishKeepChange,
  finishSaveChange,
  appExecutor,
  launchFilingChange,
  resumeUnarchiveChange,
  transferFilingChange
} from './session-organization-app-changes'
import { SAVED_SESSIONS_FOLDER_ID } from './session-folders'
import {
  CHECKOUT,
  createOrganizationTestStores,
  fakeOrganizationRpc,
  SALES
} from './session-organization-test-fixture'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const OPERATION = '00000000-0000-4000-8000-0000000000aa'

function setup(answers: Record<string, unknown> = {}) {
  const stores = createOrganizationTestStores()
  const { rpc, calls } = fakeOrganizationRpc(answers)
  return { stores, calls, deps: { stores, rpc, mintOpId: () => 'op-1' } }
}

/** `<prepare|applied|failed> <kind> <executor>` for each record written. */
const phases = (calls: { method: string; params: Record<string, unknown> }[]) =>
  calls.map(({ method, params }) => {
    const change = params.change as {
      kind: string
      executor: { kind: string } & Record<string, string>
    }
    const who = [change.executor.kind, change.executor.feature ?? change.executor.source]
      .filter(Boolean)
      .join('/')
    return `${method === 'sessionOrganization.prepare' ? 'prepare' : String(params.phase)} ${change.kind} ${who}`
  })

describe('app and launch changes', () => {
  it('files a launched conversation with the built-in reason, recorded before it moves', async () => {
    const order: string[] = []
    const { stores, calls, deps } = setup({
      'sessionOrganization.prepare': () => {
        order.push(`prepare:${stores.folders.getState().metadata.membership.b ?? 'unfiled'}`)
        return {}
      }
    })
    const result = await applyRecordedChange(launchFilingChange('b', CHECKOUT, 'tab-b'), deps)
    expect(result).toEqual({ ok: true })
    expect(order).toEqual(['prepare:unfiled'])
    expect(stores.folders.getState().metadata.membership.b).toBe(CHECKOUT)
    expect(phases(calls)).toEqual([
      'prepare move launch/session-launch',
      'applied move launch/session-launch'
    ])
    expect(calls[0]!.params.change).toMatchObject({
      targets: [{ sessionKey: 'b', tabId: 'tab-b' }],
      value: CHECKOUT,
      reason: 'filed at launch'
    })
    expect(calls[1]!.params).toMatchObject({ before: [null], after: [CHECKOUT] })
  })

  it('refuses when the record cannot be written first: nothing moves', async () => {
    const { stores, calls, deps } = setup({
      'sessionOrganization.prepare': () => {
        throw new Error('Nothing changed: the change could not be recorded first.')
      }
    })
    const result = await applyRecordedChange(launchFilingChange('b', CHECKOUT), deps)
    expect(result).toEqual({
      ok: false,
      error: 'Nothing changed: the change could not be recorded first.'
    })
    expect(stores.folders.getState().metadata.membership.b).toBeUndefined()
    expect(phases(calls)).toEqual(['prepare move launch/session-launch'])
  })

  it('files a transfer with its durable receipt as app/transfer', async () => {
    const { stores, calls, deps } = setup()
    const result = await applyRecordedChange(transferFilingChange('b', SALES, OPERATION), deps)
    expect(result).toEqual({ ok: true })
    expect(stores.folders.getState().readTransferReceipt(OPERATION)).toMatchObject({
      sessionKey: 'b',
      folderId: SALES
    })
    expect(phases(calls)).toEqual(['prepare move app/transfer', 'applied move app/transfer'])
  })

  it('settles as failed, changing nothing, when the transfer expired while it was prepared', async () => {
    const { stores, calls, deps } = setup()
    const result = await applyRecordedChange(transferFilingChange('b', SALES, OPERATION, 0), deps)
    expect(result.ok).toBe(false)
    expect(stores.folders.getState().metadata.membership.b).toBeUndefined()
    expect(phases(calls)).toEqual(['prepare move app/transfer', 'failed move app/transfer'])
  })

  it('records an automatic archive as app/auto-archive, and a refused one as failed', async ({
    onTestFinished
  }) => {
    const { stores, calls, deps } = setup()
    expect(await applyRecordedChange(autoArchiveChange('a', 'proof'), deps)).toEqual({
      ok: false,
      error: 'The automatic archive safety check is not ready.'
    })
    // This organization fixture starts after the finish lifecycle has established eligibility.
    onTestFinished(setAutomaticArchiveChecks({ refusal: () => null, receipt: () => 'proof' }))
    expect(await applyRecordedChange(autoArchiveChange('a', 'proof'), deps)).toEqual({ ok: true })
    expect(stores.view.getState().archived).toEqual(['a'])
    expect(stores.view.getState().view.autoArchiveLog?.at(-1)).toMatchObject({
      key: 'a',
      proof: 'proof'
    })
    // Already archived: the store refuses the receipt, so the change settles as failed.
    const refused = await applyRecordedChange(autoArchiveChange('a', 'proof'), deps)
    expect(refused.ok).toBe(false)
    expect(phases(calls)).toEqual([
      'prepare archive app/auto-archive',
      'failed archive app/auto-archive',
      'prepare archive app/auto-archive',
      'applied archive app/auto-archive',
      'prepare archive app/auto-archive',
      'failed archive app/auto-archive'
    ])
  })

  it('brings a resumed session back with the resume origin, as app/auto-archive', async () => {
    const { stores, calls, deps } = setup()
    stores.view.getState().setArchived(['a'], true)
    const result = await applyRecordedChange(resumeUnarchiveChange('a'), deps)
    expect(result).toEqual({ ok: true })
    expect(stores.view.getState().archived).toEqual([])
    expect(phases(calls)).toEqual([
      'prepare unarchive app/auto-archive',
      'applied unarchive app/auto-archive'
    ])
  })

  it('saves and keeps a finished session as app/finish', async () => {
    const { stores, calls, deps } = setup()
    const saved = await applyRecordedChange(
      finishSaveChange('b', SAVED_SESSIONS_FOLDER_ID, appExecutor('finish')),
      deps
    )
    expect(saved).toEqual({ ok: true })
    expect(stores.folders.getState().metadata.membership.b).toBe(SAVED_SESSIONS_FOLDER_ID)
    const keep = finishKeepChange(
      'b',
      { action: 'me', folderId: null },
      appExecutor('finish'),
      stores
    )!
    expect(await applyRecordedChange(keep, deps)).toEqual({ ok: true })
    expect(stores.folders.getState().metadata.membership.b).toBeUndefined()
    expect(stores.folders.getState().metadata.finishActions?.b).toMatchObject({
      action: 'me',
      applied: true
    })
    expect(phases(calls)).toEqual([
      'prepare save app/finish',
      'applied save app/finish',
      'prepare move app/finish',
      'applied move app/finish'
    ])
    // A session that is not saved has no placement to change: nothing to record.
    expect(
      finishKeepChange('a', { action: 'me', folderId: null }, appExecutor('finish'), stores)
    ).toBeNull()
  })
})
