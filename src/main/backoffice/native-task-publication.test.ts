import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import {
  captureConsoleWorkflowPerson,
  sanitizeConsoleWorkflowText
} from './console-workflow-person'
import {
  retainNativeTaskObservation,
  recoverNativeTaskPublications
} from './native-task-publication'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  sanitizeConsoleWorkflowText: vi.fn()
}))
const scope = {
  principal: 'b'.repeat(64),
  profileKey: 'd'.repeat(64),
  baseUrl: 'https://console.example.com'
}
const person = { ...scope, bearer: 'private-token', isCurrent: () => true }
const observation = {
  hubTaskId: 'btk_12345678',
  runId: 'session_123',
  journalCursor: 'cursor_123',
  event: 'checkpoint_written' as const
}
let root: string
const open = () =>
  openAgentSessionJournal({
    journalDir: root,
    identity: {
      sessionId: 'session_123',
      workspaceId: 'folder_123',
      hostId: 'remote-host',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread_123' }
    }
  })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'native-save-delivery-'))
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({ ok: true, data: person })
  vi.mocked(sanitizeConsoleWorkflowText).mockImplementation((value) => value)
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})
function acknowledge(_url: unknown, init: RequestInit) {
  return Response.json({
    ...JSON.parse(String(init.body)),
    id: 'tve_saved',
    task_id: observation.hubTaskId,
    note_replay_version: 1
  })
}

describe('native journal delivery', () => {
  it('retains before network and confirms the exact request in the reopened journal', async () => {
    const journal = await open()
    const network = vi.fn(async (url, init) => {
      expect((await open()).taskPublications()[0].noteId).toBeNull()
      return acknowledge(url, init)
    })
    vi.stubGlobal('fetch', network)
    await retainNativeTaskObservation(journal, observation, scope, 1)
    expect(network).not.toHaveBeenCalled()
    await recoverNativeTaskPublications(journal, 1, () => true)
    expect((await open()).taskPublications()[0].noteId).toBe('tve_saved')
    await recoverNativeTaskPublications(journal, 1, () => true)
    expect(network).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(journal.taskPublications())).not.toContain(person.bearer)
  })

  it('replays the same request after lost response and process-equivalent reopen', async () => {
    const network = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockImplementation(acknowledge)
    vi.stubGlobal('fetch', network)
    const journal = await open()
    await retainNativeTaskObservation(journal, observation, scope, 1)
    await recoverNativeTaskPublications(journal, 1, () => true)
    const restored = await open()
    expect(restored.taskPublications()[0].noteId).toBeNull()
    await recoverNativeTaskPublications(restored, 2, () => true)
    expect(network.mock.calls[0][1].body).toBe(network.mock.calls[1][1].body)
    expect(restored.taskPublications()[0].noteId).toBe('tve_saved')
  })

  it('retains pending work when authentication belongs to another person', async () => {
    const journal = await open()
    await retainNativeTaskObservation(journal, observation, scope, 1)
    vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
      ok: true,
      data: { ...person, principal: 'c'.repeat(64) }
    })
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    await recoverNativeTaskPublications(journal, 1, () => true)
    expect(network).not.toHaveBeenCalled()
    expect(journal.taskPublications()[0].noteId).toBeNull()
    await expect(
      retainNativeTaskObservation(
        journal,
        { ...observation, journalCursor: 'next' },
        { ...scope, principal: 'c'.repeat(64) },
        1
      )
    ).rejects.toThrow()
  })

  it('refuses another IDE profile even when the account and server are identical', async () => {
    const journal = await open()
    await retainNativeTaskObservation(journal, observation, scope, 1)
    vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
      ok: true,
      data: { ...person, profileKey: 'e'.repeat(64) }
    })
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    await recoverNativeTaskPublications(journal, 1, () => true)
    expect(network).not.toHaveBeenCalled()
    expect(journal.taskPublications()[0].noteId).toBeNull()
    await expect(
      retainNativeTaskObservation(
        journal,
        { ...observation, journalCursor: 'next' },
        { ...scope, profileKey: 'e'.repeat(64) },
        1
      )
    ).rejects.toThrow()
  })

  it('preserves old unbound records without attributing them to the active profile', async () => {
    const journal = await open()
    await retainNativeTaskObservation(journal, observation, scope, 1)
    const retained = journal.taskPublications()[0]
    delete retained.profileKey
    vi.spyOn(journal, 'taskPublications').mockReturnValue([retained])
    vi.spyOn(journal, 'saveTaskPublication').mockResolvedValue()
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    await recoverNativeTaskPublications(journal, 1, () => true)
    expect(network).not.toHaveBeenCalled()
    await expect(retainNativeTaskObservation(journal, observation, scope, 1)).rejects.toThrow()
  })

  it('checks the current task after asynchronous account capture', async () => {
    const journal = await open()
    await retainNativeTaskObservation(journal, observation, scope, 1)
    let current = true
    vi.mocked(captureConsoleWorkflowPerson).mockImplementation(async () => {
      current = false
      return { ok: true, data: person }
    })
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    await recoverNativeTaskPublications(journal, 1, () => current)
    expect(network).not.toHaveBeenCalled()
  })

  it('recovers the current task beyond an older task backlog without changing old notes', async () => {
    const journal = await open()
    for (let index = 0; index < 4; index += 1) {
      await retainNativeTaskObservation(
        journal,
        { ...observation, hubTaskId: 'btk_previous', journalCursor: `previous-${index}` },
        scope,
        1
      )
    }
    const previous = journal.taskPublications()
    for (let index = 0; index < 4; index += 1) {
      await retainNativeTaskObservation(
        journal,
        { ...observation, journalCursor: `current-${index}` },
        scope,
        1
      )
    }
    const network = vi.fn(acknowledge)
    vi.stubGlobal('fetch', network)
    const currentTask = (taskId: string) => taskId === observation.hubTaskId
    await recoverNativeTaskPublications(journal, 1, currentTask)
    expect(network).toHaveBeenCalledTimes(3)
    expect((await open()).taskPublications().slice(0, 4)).toEqual(previous)
    await recoverNativeTaskPublications(journal, 1, currentTask)
    expect(network).toHaveBeenCalledTimes(4)
    const restored = (await open()).taskPublications()
    expect(restored.slice(0, 4)).toEqual(previous)
    expect(restored.slice(4).every((row) => row.noteId === 'tve_saved')).toBe(true)
  })

  it('serializes concurrent recovery without duplicate sends', async () => {
    const journal = await open()
    await retainNativeTaskObservation(journal, observation, scope, 1)
    const network = vi.fn(acknowledge)
    vi.stubGlobal('fetch', network)
    await Promise.all([
      recoverNativeTaskPublications(journal, 1, () => true),
      recoverNativeTaskPublications(journal, 1, () => true)
    ])
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('does not send when the local persistence barrier fails', async () => {
    const journal = await open()
    await retainNativeTaskObservation(journal, observation, scope, 1)
    vi.spyOn(journal, 'saveTaskPublication').mockRejectedValueOnce(new Error('disk full'))
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    await expect(recoverNativeTaskPublications(journal, 1, () => true)).rejects.toThrow('disk full')
    expect(network).not.toHaveBeenCalled()
  })
})
