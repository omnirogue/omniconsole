import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_STEWARD_STATUS_RPC } from '../../../../shared/session-steward-status'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { startSessionSteward } from '../../../session-steward/steward-runtime'
import { SESSION_ORGANIZATION_LOCAL_ONLY_ERROR } from './session-organization'
import type { RpcContext, RpcMethod } from '../core'
import {
  SESSION_STEWARD_NOT_RUNNING,
  SESSION_STEWARD_STATUS_METHODS
} from './session-steward-status'

const WINDOW = {
  clientId: 'desktop-renderer',
  clientKind: 'runtime',
  connectionId: 'desktop-renderer:1'
} as const

function call<T>(name: string, params: unknown, extra: Partial<RpcContext> = WINDOW): Promise<T> {
  const method = SESSION_STEWARD_STATUS_METHODS.find((entry) => entry.name === name) as RpcMethod
  const parsed = method.params ? method.params.parse(params) : params
  return Promise.resolve(
    method.handler(parsed, { ...extra, runtime: {} as RpcContext['runtime'] } as RpcContext)
  ) as Promise<T>
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-status-rpc-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('sessionSteward.status / finished', () => {
  it('answers the window and the local CLI, never a paired phone', async () => {
    await expect(
      call(SESSION_STEWARD_STATUS_RPC.status, {}, { pairedDeviceId: 'phone', clientKind: 'mobile' })
    ).rejects.toThrow(SESSION_ORGANIZATION_LOCAL_ONLY_ERROR)
    expect(await call(SESSION_STEWARD_STATUS_RPC.status, undefined, {})).toMatchObject({
      off: SESSION_STEWARD_NOT_RUNNING,
      stalled: []
    })
    expect(await call(SESSION_STEWARD_STATUS_RPC.finished, { since: 0 })).toEqual({ cards: [] })
  })

  it('reads the running steward', async () => {
    const stop = startSessionSteward({
      runtime: {} as OrcaRuntimeService,
      store: { getSettings: () => ({}) } as unknown as Store,
      userDataPath: dir
    })
    expect(await call(SESSION_STEWARD_STATUS_RPC.status, {})).toMatchObject({
      prompts: { today: 0 },
      activity: []
    })
    await stop()
  })

  it('refuses fields it does not know', () => {
    const method = SESSION_STEWARD_STATUS_METHODS.find(
      (entry) => entry.name === SESSION_STEWARD_STATUS_RPC.finished
    )!
    expect(() => method.params!.parse({ since: 0, actor: 'steward' })).toThrow()
  })
})
