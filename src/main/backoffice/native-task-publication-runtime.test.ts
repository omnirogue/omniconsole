import { syncBackofficeFromSettings } from './backoffice-config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeJournalObservation } from '../native-chat/agent-session-wire/structured-agent-session-host-types'
import { currentConsolePublicationScope } from './console-workflow-person'
import {
  recoverNativeTaskPublications,
  retainNativeTaskObservation
} from './native-task-publication'
import {
  nativeJournalPublicationCallbacks,
  resumeNativeTaskPublication
} from './native-task-publication-runtime'
vi.mock('./console-workflow-person', () => ({ currentConsolePublicationScope: vi.fn() }))
vi.mock('./native-task-publication', () => ({
  recoverNativeTaskPublications: vi.fn(),
  retainNativeTaskObservation: vi.fn()
}))
let current: boolean
let input: NativeJournalObservation
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('OMNI_NATIVE_TASK_SAVE_DELIVERY', '1')
  current = true
  input = {
    record: { sessionId: 'session_123', hubTaskId: 'btk_12345678', lease: { runtimeFence: 2 } },
    cursor: { epoch: 'epoch_123', sequence: 2 },
    journal: { taskPublications: () => [{ taskId: 'btk_12345678', noteId: null }] },
    isCurrent: () => current
  } as unknown as NativeJournalObservation
  vi.mocked(currentConsolePublicationScope).mockReturnValue({
    principal: 'a'.repeat(64),
    profileKey: 'd'.repeat(64),
    baseUrl: 'https://console.example.com'
  })
  vi.mocked(retainNativeTaskObservation).mockResolvedValue()
  vi.mocked(recoverNativeTaskPublications).mockResolvedValue()
})
afterEach(async () => {
  current = false
  await vi.advanceTimersByTimeAsync(30_000)
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
describe('native lifecycle publication registration', () => {
  it('waits for local retention before starting delivery', async () => {
    let finish!: () => void
    vi.mocked(retainNativeTaskObservation).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const saving = nativeJournalPublicationCallbacks.onCheckpoint(input)
    expect(recoverNativeTaskPublications).not.toHaveBeenCalled()
    finish()
    await saving
    expect(recoverNativeTaskPublications).toHaveBeenCalledOnce()
  })
  it('retries a restored pending journal and stops when its task binding is no longer current', async () => {
    resumeNativeTaskPublication(input)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(recoverNativeTaskPublications).toHaveBeenCalledTimes(2)
    current = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(recoverNativeTaskPublications).toHaveBeenCalledTimes(2)
  })
  it('sends a new checkpoint immediately while an outage retry timer exists', async () => {
    resumeNativeTaskPublication(input)
    await Promise.resolve()
    await nativeJournalPublicationCallbacks.onCheckpoint(input)
    expect(recoverNativeTaskPublications).toHaveBeenCalledTimes(2)
  })
  it('coalesces checkpoints during delivery into one immediate follow-up pass', async () => {
    let finish!: () => void
    vi.mocked(recoverNativeTaskPublications).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    resumeNativeTaskPublication(input)
    await nativeJournalPublicationCallbacks.onCheckpoint(input)
    await nativeJournalPublicationCallbacks.onCheckpoint(input)
    expect(recoverNativeTaskPublications).toHaveBeenCalledOnce()
    finish()
    await Promise.resolve()
    expect(recoverNativeTaskPublications).toHaveBeenCalledTimes(2)
  })
  it('replaces a retry owned by a detached task binding', async () => {
    let attached = true
    const previous = { ...input, isCurrent: () => attached }
    resumeNativeTaskPublication(previous)
    await Promise.resolve()
    attached = false
    resumeNativeTaskPublication(input)
    await Promise.resolve()
    expect(recoverNativeTaskPublications).toHaveBeenLastCalledWith(
      input.journal,
      input.record.lease.runtimeFence,
      input.isCurrent
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(recoverNativeTaskPublications).toHaveBeenCalledTimes(3)
  })
  it('does not follow a queued checkpoint into a detached binding', async () => {
    let finish!: () => void
    vi.mocked(recoverNativeTaskPublications).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    resumeNativeTaskPublication(input)
    await nativeJournalPublicationCallbacks.onCheckpoint(input)
    current = false
    finish()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(recoverNativeTaskPublications).toHaveBeenCalledOnce()
  })
  it('uses a fresh observation after the account connection invalidates the old retry', async () => {
    resumeNativeTaskPublication(input)
    await Promise.resolve()
    syncBackofficeFromSettings({
      backofficeEnv: 'production',
      backofficeProductionUrl: 'https://runtime-invalidation.example.com'
    })
    const next = { ...input, isCurrent: () => current }
    resumeNativeTaskPublication(next)
    await Promise.resolve()
    expect(recoverNativeTaskPublications).toHaveBeenLastCalledWith(
      next.journal,
      next.record.lease.runtimeFence,
      next.isCurrent
    )
  })
  it('projects restored history status without delivery, writes or retry timers', async () => {
    const onTaskSave = vi.fn()
    const restored = { ...input, readOnly: true, onTaskSave }
    resumeNativeTaskPublication(restored)
    expect(onTaskSave).toHaveBeenCalledOnce()
    expect(recoverNativeTaskPublications).not.toHaveBeenCalled()
    expect(retainNativeTaskObservation).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(recoverNativeTaskPublications).not.toHaveBeenCalled()
    await expect(nativeJournalPublicationCallbacks.onCheckpoint(restored)).rejects.toThrow(
      'history-only'
    )
    expect(retainNativeTaskObservation).not.toHaveBeenCalled()
  })
  it('retains a confirmed-stop closeout with the execution fence in its replay identity', async () => {
    await nativeJournalPublicationCallbacks.onStopped!(input)
    expect(retainNativeTaskObservation).toHaveBeenCalledWith(
      input.journal,
      expect.objectContaining({
        event: 'stop_confirmed',
        journalCursor: expect.stringContaining('closeout-fence:2')
      }),
      expect.anything(),
      2
    )
  })
  it('does not start background recovery until the receiver rollout switch is enabled', () => {
    vi.stubEnv('OMNI_NATIVE_TASK_SAVE_DELIVERY', '')
    expect(nativeJournalPublicationCallbacks.enabled()).toBe(false)
    resumeNativeTaskPublication(input)
    expect(recoverNativeTaskPublications).not.toHaveBeenCalled()
  })
  it('does not start delivery after local persistence fails', async () => {
    vi.mocked(retainNativeTaskObservation).mockRejectedValueOnce(new Error('disk full'))
    await expect(nativeJournalPublicationCallbacks.onStarted(input)).rejects.toThrow('disk full')
    expect(recoverNativeTaskPublications).not.toHaveBeenCalled()
  })
})
