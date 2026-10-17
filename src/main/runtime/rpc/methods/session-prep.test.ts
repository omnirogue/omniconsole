import { describe, expect, it, vi } from 'vitest'
import { SESSION_PREP_RPC } from '../../../../shared/session-prep-types'
import type { RpcContext, RpcMethod } from '../core'
import { SESSION_PREP_METHODS } from './session-prep'

const SOURCE = { worktreeId: 'repo-1::/src', paneKey: 'pane-1', agent: 'claude' }
const BATCH = {
  id: 'sp_1',
  createdAt: 1,
  state: 'running' as const,
  source: SOURCE,
  request: 'create sessions',
  items: []
}

function method(name: string): RpcMethod {
  return SESSION_PREP_METHODS.find((entry) => entry.name === name)!
}

function call(name: string, params: unknown, over: Partial<RpcContext> = {}): unknown {
  const runtime = {
    getSessionPrepService: () => ({
      request: vi.fn(() => ({ batchId: 'sp_1' })),
      get: vi.fn(() => BATCH),
      listForSource: vi.fn(() => [BATCH]),
      cancel: vi.fn(async () => BATCH),
      confirm: vi.fn(async () => BATCH)
    })
  }
  const ctx = {
    clientId: 'desktop-renderer',
    runtime,
    ...over
  } as unknown as RpcContext
  const target = method(name)
  const parsed = target.params ? target.params.parse(params) : params
  return target.handler(parsed, ctx)
}

describe('sessionPrep RPC', () => {
  it('allows the desktop renderer', async () => {
    expect(
      call(SESSION_PREP_RPC.request, { text: 'create sessions for login', source: SOURCE })
    ).toEqual({ batchId: 'sp_1' })
    expect(call(SESSION_PREP_RPC.get, { batchId: 'sp_1' })).toEqual({ batch: BATCH })
    expect(call(SESSION_PREP_RPC.listForSource, { paneKey: 'pane-1' })).toEqual({
      batches: [BATCH]
    })
    await expect(call(SESSION_PREP_RPC.cancel, { batchId: 'sp_1' })).resolves.toEqual({
      batch: BATCH
    })
    await expect(call(SESSION_PREP_RPC.confirm, { batchId: 'sp_1' })).resolves.toEqual({
      batch: BATCH
    })
  })

  it('accepts a default folder for the prepared sessions and refuses unknown keys', () => {
    const request = vi.fn(() => ({ batchId: 'sp_2' }))
    const runtime = { getSessionPrepService: () => ({ request }) }
    const params = { text: 'create sessions for login', source: SOURCE, defaultFolder: 'fld-1' }
    expect(
      call(SESSION_PREP_RPC.request, params, { runtime } as unknown as Partial<RpcContext>)
    ).toEqual({ batchId: 'sp_2' })
    expect(request).toHaveBeenCalledWith({ ...params, context: '' })
    expect(() =>
      call(SESSION_PREP_RPC.request, { ...params, folder: 'fld-1', defaultFolder: undefined })
    ).toThrow()
  })

  it('refuses an agent holding an orchestration capability', () => {
    expect(() =>
      call(
        SESSION_PREP_RPC.request,
        { text: 'create sessions for login', source: SOURCE },
        { orchestrationCapability: 'dcap_worker' }
      )
    ).toThrow('authenticated user interface')
    expect(() =>
      call(SESSION_PREP_RPC.get, { batchId: 'sp_1' }, { orchestrationCapability: 'x' })
    ).toThrow('authenticated user interface')
  })

  it('refuses CLI and other non-renderer callers', () => {
    expect(() =>
      call(
        SESSION_PREP_RPC.request,
        { text: 'create sessions for login', source: SOURCE },
        { clientId: undefined }
      )
    ).toThrow('authenticated user interface')
    expect(() => call(SESSION_PREP_RPC.cancel, { batchId: 'sp_1' }, { clientId: 'cli' })).toThrow(
      'authenticated user interface'
    )
    expect(() =>
      call(
        SESSION_PREP_RPC.confirm,
        { batchId: 'sp_1' },
        { clientId: undefined, clientKind: 'runtime' }
      )
    ).toThrow('authenticated user interface')
  })
})
