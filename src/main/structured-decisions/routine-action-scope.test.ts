import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationOwnerPrecondition } from '../../shared/automation-owner-precondition'
import type { Store } from '../persistence'
import { captureRoutineActionScope } from './routine-action-scope'
import { readRoutineDecisionSource } from './routine-decision-records'

vi.mock('./routine-decision-records', () => ({ readRoutineDecisionSource: vi.fn() }))

const ROUTINE_ID = 'fixture-routine'
const RUN_ID = 'fixture-run'
const SOURCE = 'a'.repeat(64)
const CHANGED_SOURCE = 'b'.repeat(64)
const REFUSAL = 'The current routine, owner or advertising action mode changed.'

function source(revision = SOURCE): ReturnType<typeof readRoutineDecisionSource> {
  return { source: revision } as ReturnType<typeof readRoutineDecisionSource>
}

function fixture(verificationOnly = false) {
  const owner = vi.fn((): AutomationOwnerPrecondition | null => ({ selector: { kind: 'self' } }))
  const store = { automationOwnerPrecondition: owner } as unknown as Store
  const active = vi.fn(() => true)
  const enabled = vi.fn((_routineId: string): void => undefined)
  const options: Parameters<typeof captureRoutineActionScope>[0] = {
    store,
    active,
    assertActionEnabled: enabled
  }
  const capture = () => captureRoutineActionScope(options, ROUTINE_ID, RUN_ID, verificationOnly)
  return { owner, store, active, enabled, options, capture }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(readRoutineDecisionSource).mockReturnValue(source())
})

describe('normal routine advertising action scope', () => {
  it('captures the exact run source and rechecks the live action mode', async () => {
    const f = fixture()
    const scope = f.capture()
    expect(scope.routineId).toBe(ROUTINE_ID)
    expect(scope.runId).toBe(RUN_ID)
    expect(readRoutineDecisionSource).toHaveBeenCalledExactlyOnceWith(f.store, ROUTINE_ID, RUN_ID)
    expect(scope.isCurrent()).toBe(true)
    expect(f.owner).toHaveBeenCalledWith(ROUTINE_ID)
    expect(f.enabled).toHaveBeenCalledExactlyOnceWith(ROUTINE_ID)
    expect(readRoutineDecisionSource).toHaveBeenCalledTimes(2)
    await expect(scope.assertCurrent!()).resolves.toBeUndefined()
    expect(f.enabled).toHaveBeenCalledTimes(2)
    expect(readRoutineDecisionSource).toHaveBeenCalledTimes(3)
  })

  it('compares the bound revision rather than an in-memory source object identity', async () => {
    const f = fixture()
    const scope = f.capture()
    vi.mocked(readRoutineDecisionSource).mockReturnValue(source())
    expect(scope.isCurrent()).toBe(true)
    await expect(scope.assertCurrent!()).resolves.toBeUndefined()
  })

  it('refuses a disposed service before source or action-mode reads', async () => {
    const f = fixture()
    const scope = f.capture()
    vi.mocked(readRoutineDecisionSource).mockClear()
    f.active.mockReturnValue(false)
    expect(scope.isCurrent()).toBe(false)
    await expect(scope.assertCurrent!()).rejects.toThrow(REFUSAL)
    expect(f.owner).not.toHaveBeenCalled()
    expect(readRoutineDecisionSource).not.toHaveBeenCalled()
    expect(f.enabled).not.toHaveBeenCalled()
  })

  it.each<AutomationOwnerPrecondition | null>([
    null,
    { selector: { kind: 'orphan' } },
    { selector: { kind: 'ssh', targetId: 'remote-host', targetGeneration: 2 } }
  ])('refuses missing or non-self execution authority: %j', async (owner) => {
    const f = fixture()
    const scope = f.capture()
    vi.mocked(readRoutineDecisionSource).mockClear()
    f.owner.mockReturnValue(owner)
    expect(scope.isCurrent()).toBe(false)
    await expect(scope.assertCurrent!()).rejects.toThrow(REFUSAL)
    expect(readRoutineDecisionSource).not.toHaveBeenCalled()
    expect(f.enabled).not.toHaveBeenCalled()
  })

  it('refuses a changed current-run source without invoking the action-mode gate', async () => {
    const f = fixture()
    const scope = f.capture()
    vi.mocked(readRoutineDecisionSource).mockReturnValue(source(CHANGED_SOURCE))
    expect(scope.isCurrent()).toBe(false)
    await expect(scope.assertCurrent!()).rejects.toThrow(REFUSAL)
    expect(f.enabled).not.toHaveBeenCalled()
  })

  it.each([
    'A completed routine run with captured output is required.',
    'Structured decisions must run on the routine execution host.',
    'Structured decisions are not enabled for this routine.',
    'A confirmed current-turn final assistant response is required for structured decisions.'
  ])('fails closed when the authoritative source reader refuses: %s', async (reason) => {
    const f = fixture()
    const scope = f.capture()
    vi.mocked(readRoutineDecisionSource).mockImplementation(() => {
      throw new Error(reason)
    })
    expect(scope.isCurrent()).toBe(false)
    await expect(scope.assertCurrent!()).rejects.toThrow(REFUSAL)
    expect(f.enabled).not.toHaveBeenCalled()
  })

  it('cannot capture an absent or unproven original source', () => {
    const f = fixture()
    const failure = new Error('A completed routine run with captured output is required.')
    vi.mocked(readRoutineDecisionSource).mockImplementation(() => {
      throw failure
    })
    expect(f.capture).toThrow(failure)
    expect(f.active).not.toHaveBeenCalled()
    expect(f.owner).not.toHaveBeenCalled()
    expect(f.enabled).not.toHaveBeenCalled()
  })

  it('requires an explicit live action-mode gate on the normal path', async () => {
    const f = fixture()
    f.options.assertActionEnabled = undefined
    const scope = f.capture()
    vi.mocked(readRoutineDecisionSource).mockClear()
    expect(scope.isCurrent()).toBe(false)
    await expect(scope.assertCurrent!()).rejects.toThrow(REFUSAL)
    expect(readRoutineDecisionSource).not.toHaveBeenCalled()
    expect(f.enabled).not.toHaveBeenCalled()
  })

  it.each(['global kill switch', 'per-routine flag', 'advertising capability mode'])(
    'refuses an action after the %s disables execution',
    async (reason) => {
      const f = fixture()
      const scope = f.capture()
      expect(scope.isCurrent()).toBe(true)
      f.enabled.mockImplementation(() => {
        throw new Error(reason)
      })
      expect(scope.isCurrent()).toBe(false)
      await expect(scope.assertCurrent!()).rejects.toThrow(REFUSAL)
    }
  )

  it.each(['active', 'owner', 'enabled'] as const)(
    'contains a thrown %s check and exposes only the scope refusal',
    async (check) => {
      const f = fixture()
      const scope = f.capture()
      const fail = () => {
        throw new Error('private diagnostic details')
      }
      f[check].mockImplementation(fail)
      expect(scope.isCurrent()).toBe(false)
      await expect(scope.assertCurrent!()).rejects.toThrow(REFUSAL)
      await expect(scope.assertCurrent!()).rejects.not.toThrow('private diagnostic details')
    }
  )
})

describe('verification-only routine scope for submitted-action readback', () => {
  it('allows recovery without a fresh source, provenance or live action-mode gate', async () => {
    const f = fixture(true)
    vi.mocked(readRoutineDecisionSource).mockImplementation(() => {
      throw new Error('source no longer exists')
    })
    f.enabled.mockImplementation(() => {
      throw new Error('kill switch enabled')
    })
    const scope = f.capture()
    expect(scope.routineId).toBe(ROUTINE_ID)
    expect(scope.runId).toBe(RUN_ID)
    expect(scope.isCurrent()).toBe(true)
    await expect(scope.assertCurrent!()).resolves.toBeUndefined()
    expect(f.active).toHaveBeenCalledTimes(2)
    expect(f.owner).toHaveBeenCalledWith(ROUTINE_ID)
    expect(readRoutineDecisionSource).not.toHaveBeenCalled()
    expect(f.enabled).not.toHaveBeenCalled()
  })

  it('does not require an action-enabling callback to inspect an uncertain submitted outcome', async () => {
    const f = fixture(true)
    f.options.assertActionEnabled = undefined
    const scope = f.capture()
    expect(scope.isCurrent()).toBe(true)
    await expect(scope.assertCurrent!()).resolves.toBeUndefined()
    expect(readRoutineDecisionSource).not.toHaveBeenCalled()
  })

  it('still refuses recovery after service disposal', async () => {
    const f = fixture(true)
    const scope = f.capture()
    f.active.mockReturnValue(false)
    expect(scope.isCurrent()).toBe(false)
    await expect(scope.assertCurrent!()).rejects.toThrow(REFUSAL)
    expect(f.owner).not.toHaveBeenCalled()
    expect(readRoutineDecisionSource).not.toHaveBeenCalled()
  })

  it.each<AutomationOwnerPrecondition | null>([
    null,
    { selector: { kind: 'orphan' } },
    { selector: { kind: 'ssh', targetId: 'other-host', targetGeneration: 1 } }
  ])('does not use readback recovery to bypass execution-host ownership: %j', async (owner) => {
    const f = fixture(true)
    const scope = f.capture()
    f.owner.mockReturnValue(owner)
    expect(scope.isCurrent()).toBe(false)
    await expect(scope.assertCurrent!()).rejects.toThrow(REFUSAL)
    expect(readRoutineDecisionSource).not.toHaveBeenCalled()
    expect(f.enabled).not.toHaveBeenCalled()
  })

  it.each(['active', 'owner'] as const)(
    'fails closed when the recovery %s guard throws',
    async (check) => {
      const f = fixture(true)
      const scope = f.capture()
      f[check].mockImplementation(() => {
        throw new Error('unavailable')
      })
      expect(scope.isCurrent()).toBe(false)
      await expect(scope.assertCurrent!()).rejects.toThrow(REFUSAL)
      expect(readRoutineDecisionSource).not.toHaveBeenCalled()
    }
  )
})
