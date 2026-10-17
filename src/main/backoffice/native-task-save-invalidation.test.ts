import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeJournalObservation } from '../native-chat/agent-session-wire/structured-agent-session-host-types'
import {
  recordSuccessfulCloudSessionLogin,
  tombstoneCloudSession
} from '../omni-profiles/profile-cloud-session-mutation'
import { syncBackofficeFromSettings } from './backoffice-config'
import {
  createNativeTaskSaveInvalidation,
  watchNativeTaskSave
} from './native-task-save-invalidation'
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omni-save-invalidation-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
function observation() {
  return {
    record: { hubTaskId: 'btk_1234' },
    journal: {},
    isCurrent: () => true,
    onTaskSave: vi.fn()
  } as unknown as NativeJournalObservation & { onTaskSave: ReturnType<typeof vi.fn> }
}
describe('native save status invalidation', () => {
  it('clears visible status during actual sign-out and login mutations', () => {
    const input = observation()
    watchNativeTaskSave(input)
    const identity = {
      localProfileId: 'local',
      cloudUserId: 'user',
      cloudProfileId: 'cloud',
      organizationId: 'org'
    }
    recordSuccessfulCloudSessionLogin(identity, root)
    expect(input.onTaskSave).toHaveBeenLastCalledWith({ taskId: 'btk_1234', state: 'unavailable' })
    input.onTaskSave.mockClear()
    tombstoneCloudSession(identity, root)
    expect(input.onTaskSave).toHaveBeenCalledOnce()
    expect(input.onTaskSave).toHaveBeenLastCalledWith({ taskId: 'btk_1234', state: 'unavailable' })
  })
  it('clears on a server change but not an unchanged settings refresh', () => {
    const input = observation()
    watchNativeTaskSave(input)
    const settings = {
      backofficeEnv: 'production' as const,
      backofficeProductionUrl: 'https://save-status.example.com'
    }
    syncBackofficeFromSettings(settings)
    expect(input.onTaskSave).toHaveBeenCalledOnce()
    input.onTaskSave.mockClear()
    syncBackofficeFromSettings(settings)
    expect(input.onTaskSave).not.toHaveBeenCalled()
    syncBackofficeFromSettings({
      ...settings,
      backofficeProductionUrl: 'https://changed.example.com'
    })
    expect(input.onTaskSave).toHaveBeenCalledOnce()
  })
  it('uses the latest observer and retires detached task bindings', () => {
    const invalidation = createNativeTaskSaveInvalidation()
    const first = observation()
    const next = { ...first, onTaskSave: vi.fn() }
    invalidation.watch(first)
    invalidation.watch(next)
    invalidation.invalidate()
    expect(first.onTaskSave).not.toHaveBeenCalled()
    expect(next.onTaskSave).toHaveBeenCalledOnce()
    next.isCurrent = () => false
    invalidation.invalidate()
    next.isCurrent = () => true
    invalidation.invalidate()
    expect(next.onTaskSave).toHaveBeenCalledOnce()
  })
  it('refuses a delayed observation after invalidation but admits a new task observation', () => {
    const invalidation = createNativeTaskSaveInvalidation()
    const input = observation()
    expect(invalidation.watch(input)).toBe(true)
    invalidation.invalidate()
    expect(invalidation.watch(input)).toBe(false)
    expect(invalidation.watch({ ...input })).toBe(true)
  })
  it('does not let a closed view stop another view from clearing', () => {
    const invalidation = createNativeTaskSaveInvalidation()
    const first = observation()
    first.onTaskSave.mockImplementation(() => {
      throw new Error('closed')
    })
    const next = observation()
    invalidation.watch(first)
    invalidation.watch(next)
    expect(() => invalidation.invalidate()).not.toThrow()
    expect(next.onTaskSave).toHaveBeenCalledOnce()
  })
})
