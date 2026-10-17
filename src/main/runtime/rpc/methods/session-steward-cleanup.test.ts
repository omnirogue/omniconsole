import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'

const admitCleanupRun = vi.hoisted(() => vi.fn(() => ({ ok: true, reservationId: 'r-1' })))
vi.mock('../../../session-steward/cleanup-runs-runtime', () => ({
  admitCleanupRun,
  cleanupRunsView: () => null
}))

const { SESSION_CLEANUP_METHODS, CLEANUP_CALLER_REFUSAL } =
  await import('./session-steward-cleanup')
const { AUTOMATION_METHODS } = await import('./automations')

const cleanupNow = SESSION_CLEANUP_METHODS.find(
  (method) => method.name === 'sessionSteward.cleanupNow'
)!

function context(fields: Partial<RpcContext>): RpcContext {
  return { runtime: {} as never, ...fields }
}

describe('sessionSteward.cleanupNow', () => {
  it('is the person asking from this computer’s window or its own CLI', () => {
    expect(
      cleanupNow.handler(
        undefined,
        context({ clientId: 'desktop-renderer', clientKind: 'runtime' })
      )
    ).toEqual({ ok: true, reservationId: 'r-1' })
    expect(cleanupNow.handler(undefined, context({}))).toMatchObject({ ok: true })
    expect(admitCleanupRun).toHaveBeenCalledWith('manual')
  })

  it('refuses a paired device, another computer, a worker and a steward run', () => {
    admitCleanupRun.mockClear()
    for (const refused of [
      { clientId: 'phone-token', clientKind: 'mobile' as const, pairedDeviceId: 'phone' },
      { clientId: 'other-desktop', clientKind: 'runtime' as const },
      { orchestrationCapability: 'dispatch-cap' },
      { unattendedCaller: { source: 'cleanup-run' as const, runId: 'run-1' } }
    ]) {
      expect(() => cleanupNow.handler(undefined, context(refused))).toThrow(CLEANUP_CALLER_REFUSAL)
    }
    expect(admitCleanupRun).not.toHaveBeenCalled()
  })
})

describe('automation.runNow', () => {
  it('can never ask for the automatic trigger: only main’s detector sets it', async () => {
    const runAutomationNow = vi.fn(async () => ({ id: 'run-1' }))
    const method = AUTOMATION_METHODS.find((entry) => entry.name === 'automation.runNow')!
    const params = method.params!.parse({ id: 'a-1', prompt: 'brief', trigger: 'automatic' })

    await method.handler(params, context({ runtime: { runAutomationNow } as never }))

    expect(runAutomationNow).toHaveBeenCalledWith('a-1', undefined, {
      promptOverride: 'brief',
      titleSuffix: undefined
    })
  })
})
