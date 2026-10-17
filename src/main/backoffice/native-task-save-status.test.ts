import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeJournalObservation } from '../native-chat/agent-session-wire/structured-agent-session-host-types'
import { currentConsolePublicationScope } from './console-workflow-person'
import { beginNativeTaskRetention, publishNativeTaskSave } from './native-task-save-status'

vi.mock('./console-workflow-person', () => ({ currentConsolePublicationScope: vi.fn() }))
const scope = {
  principal: 'a'.repeat(64),
  profileKey: 'b'.repeat(64),
  baseUrl: 'https://console.example.com'
}
let rows: (typeof scope & { taskId: string; noteId: string | null })[]
let input: NativeJournalObservation
const notify = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(currentConsolePublicationScope).mockReturnValue(scope)
  rows = [{ ...scope, taskId: 'btk_12345678', noteId: 'tve_confirmed' }]
  input = {
    record: { hubTaskId: 'btk_12345678' },
    journal: { taskPublications: () => rows },
    isCurrent: () => true,
    onTaskSave: notify
  } as unknown as NativeJournalObservation
})
describe('native task note status', () => {
  it('requires matching saved receipts and publishes no account or request details', () => {
    publishNativeTaskSave(input)
    expect(notify).toHaveBeenLastCalledWith({ taskId: 'btk_12345678', state: 'shared' })
    rows[0].noteId = null
    publishNativeTaskSave(input)
    expect(notify).toHaveBeenLastCalledWith({ taskId: 'btk_12345678', state: 'pending' })
  })
  it.each(['principal', 'profileKey', 'baseUrl'] as const)(
    'does not reuse confirmation across a %s switch',
    (key) => {
      rows[0][key] = 'different'
      publishNativeTaskSave(input)
      expect(notify).toHaveBeenLastCalledWith({ taskId: 'btk_12345678', state: 'unavailable' })
    }
  )
  it('does not call an empty journal saved', () => {
    rows = []
    publishNativeTaskSave(input)
    expect(notify).toHaveBeenLastCalledWith({ taskId: 'btk_12345678', state: 'unavailable' })
  })
  it('keeps a new write and its failure above an older shared receipt', () => {
    const finish = beginNativeTaskRetention(input)
    publishNativeTaskSave(input)
    expect(notify).toHaveBeenLastCalledWith({ taskId: 'btk_12345678', state: 'saving' })
    finish(false)
    publishNativeTaskSave(input)
    expect(notify).toHaveBeenLastCalledWith({ taskId: 'btk_12345678', state: 'attention' })
    beginNativeTaskRetention(input)(true)
    expect(notify).toHaveBeenLastCalledWith({ taskId: 'btk_12345678', state: 'shared' })
  })
  it('does not let an older write completion hide a newer failure', () => {
    const older = beginNativeTaskRetention(input)
    const newer = beginNativeTaskRetention(input)
    newer(false)
    older(true)
    publishNativeTaskSave(input)
    expect(notify).toHaveBeenLastCalledWith({ taskId: 'btk_12345678', state: 'attention' })
  })
  it('stops reporting after the canonical task binding changes', () => {
    input.isCurrent = () => false
    publishNativeTaskSave(input)
    expect(notify).not.toHaveBeenCalled()
  })
})
