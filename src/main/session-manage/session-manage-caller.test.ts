import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../runtime/rpc/core'
import {
  assertSessionManageCaller,
  resolveSessionManageActor,
  SESSION_MANAGE_CAPABILITY_ERROR,
  SESSION_MANAGE_LOCAL_ONLY_ERROR
} from './session-manage-caller'

function context(extra: Partial<RpcContext>): RpcContext {
  return { runtime: {} as RpcContext['runtime'], ...extra }
}

const evidence = { terminalHandle: 'term_9', paneKey: 'tab-9:leaf-9', launchToken: 'secret' }
const titles = (paneKey: string) => (paneKey === 'tab-9:leaf-9' ? 'Manager' : null)

describe('session manage caller gate', () => {
  it('admits the local socket, with or without pane evidence', () => {
    expect(() => assertSessionManageCaller(context({}))).not.toThrow()
    expect(() =>
      assertSessionManageCaller(context({ orchestrationCompatibilityEvidence: evidence }))
    ).not.toThrow()
  })

  it('refuses a paired device, the renderer, a remote runtime and a dispatch capability', () => {
    for (const extra of [
      { pairedDeviceId: 'device' },
      { clientId: 'desktop-renderer' },
      { clientKind: 'mobile' as const },
      { clientKind: 'runtime' as const }
    ]) {
      expect(() => assertSessionManageCaller(context(extra))).toThrow(
        SESSION_MANAGE_LOCAL_ONLY_ERROR
      )
    }
    expect(() => assertSessionManageCaller(context({ orchestrationCapability: 'cap' }))).toThrow(
      SESSION_MANAGE_CAPABILITY_ERROR
    )
  })
})

describe('resolveSessionManageActor', () => {
  it('is the plain CLI without pane evidence', () => {
    const verify = vi.fn()
    expect(resolveSessionManageActor(undefined, verify, titles)).toEqual({ kind: 'cli' })
    expect(verify).not.toHaveBeenCalled()
  })

  it('names the pane the host proved, with its sidebar title', () => {
    expect(resolveSessionManageActor(evidence, () => 'tab-9:leaf-9', titles)).toEqual({
      kind: 'pane',
      paneKey: 'tab-9:leaf-9',
      title: 'Manager'
    })
  })

  it('records a claim the host could not prove as the CLI, never as that pane', () => {
    expect(resolveSessionManageActor(evidence, () => null, titles)).toEqual({
      kind: 'cli',
      unverifiedPaneKey: 'tab-9:leaf-9'
    })
    const throwing = () => {
      throw new Error('attestation failed')
    }
    expect(resolveSessionManageActor(evidence, throwing, titles)).toEqual({
      kind: 'cli',
      unverifiedPaneKey: 'tab-9:leaf-9'
    })
  })

  it('takes the proven pane over the claimed one', () => {
    expect(
      resolveSessionManageActor(
        { ...evidence, paneKey: 'tab-1:forged' },
        () => 'tab-9:leaf-9',
        titles
      )
    ).toMatchObject({ kind: 'pane', paneKey: 'tab-9:leaf-9' })
  })
})
