import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSessionWrittenFilesStore,
  SESSION_WRITTEN_FILES_FILE,
  SessionWrittenFilesStore,
  startSessionWrittenFiles
} from './session-written-files-store'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'session-written-files-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const write = (toolInput: string, extra: Record<string, unknown> = {}) => ({
  paneKey: 'tab-1:1',
  hookEventName: 'PostToolUse',
  providerSession: { id: 'session-a' },
  payload: { agentType: 'gemini', toolName: 'Write', toolInput },
  ...extra
})

/** A file as the first release (#705) saved it: by pane, the session when the provider named one. */
function seedFirstRelease(): void {
  writeFileSync(
    join(directory, SESSION_WRITTEN_FILES_FILE),
    JSON.stringify({
      version: 1,
      conversations: [
        { paneKey: 'tab-1:1', sessionId: 'session-a', paths: ['/w/old-a.md'] },
        { paneKey: 'tab-2:1', sessionId: null, paths: ['/w/unattributed.md'] },
        { paneKey: 'tab-3:1', sessionId: 'session-c', paths: ['/w/old-c.md'] }
      ]
    })
  )
}

const saved = (): { version: number; sessions: unknown[]; legacy: unknown[] } =>
  JSON.parse(readFileSync(join(directory, SESSION_WRITTEN_FILES_FILE), 'utf8'))

describe('SessionWrittenFilesStore', () => {
  it('records each finished write once per provider session, newest last', () => {
    const store = new SessionWrittenFilesStore({ directory })
    store.observe(write('/w/a.md'))
    store.observe(
      write('/w/b.ts', {
        hookEventName: 'AfterTool',
        payload: { agentType: 'gemini', toolName: 'write_file', toolInput: '/w/b.ts' }
      })
    )
    store.observe(write('/w/a.md'))
    expect(store.pathsFor('gemini', 'session-a')).toEqual(['/w/b.ts', '/w/a.md'])
  })

  it('never attributes a write it cannot tie to a provider session, nor a proposed one', () => {
    const store = new SessionWrittenFilesStore({ directory })
    store.observe(write('/w/a.md', { providerSession: undefined }))
    store.observe(write('/w/a.md', { hookEventName: 'PreToolUse' }))
    store.observe(
      write('/w/a.md', { payload: { agentType: 'gemini', toolName: 'Read', toolInput: '/w/a.md' } })
    )
    store.observe(write('{"content":"notes"}'))
    expect(store.list()).toEqual([])
  })

  it('keeps one session’s files when another takes its pane, for when it is resumed anywhere', () => {
    const store = new SessionWrittenFilesStore({ directory })
    store.observe(write('/w/a.md'))
    store.observe(write('/w/c.md', { providerSession: { id: 'session-b' } }))
    expect(store.pathsFor('gemini', 'session-a')).toEqual(['/w/a.md'])
    expect(store.pathsFor('gemini', 'session-b')).toEqual(['/w/c.md'])
    expect(store.pathsFor('kimi', 'session-a')).toEqual([])
  })

  it('takes writes replayed from the spool and keeps its record across a restart', async () => {
    const store = new SessionWrittenFilesStore({ directory })
    store.observe(write('/w/a.md', { isReplay: true }))
    await store.flush()
    const reloaded = new SessionWrittenFilesStore({ directory })
    reloaded.load()
    expect(reloaded.pathsFor('gemini', 'session-a')).toEqual(['/w/a.md'])
  })

  it('upgrading keeps the first release’s records: served by session id, never overwritten', async () => {
    seedFirstRelease()
    const store = new SessionWrittenFilesStore({ directory })
    store.load()
    expect(store.pathsFor('kimi', 'session-c')).toEqual(['/w/old-c.md'])
    store.observe(write('/w/new-b.md', { providerSession: { id: 'session-b' } }))
    await store.flush()
    expect(saved().version).toBe(2)
    expect(saved().legacy).toEqual([
      { paneKey: 'tab-1:1', sessionId: 'session-a', paths: ['/w/old-a.md'] },
      { paneKey: 'tab-2:1', sessionId: null, paths: ['/w/unattributed.md'] },
      { paneKey: 'tab-3:1', sessionId: 'session-c', paths: ['/w/old-c.md'] }
    ])
  })

  it('moves a first-release record onto its session once a hook names the provider', async () => {
    seedFirstRelease()
    const store = new SessionWrittenFilesStore({ directory })
    store.load()
    store.observe({
      paneKey: 'tab-9:1',
      hookEventName: 'UserPromptSubmit',
      providerSession: { id: 'session-a' },
      payload: { agentType: 'gemini' }
    })
    store.observe(write('/w/new-a.md', { paneKey: 'tab-9:1' }))
    await store.flush()
    expect(store.pathsFor('gemini', 'session-a')).toEqual(['/w/old-a.md', '/w/new-a.md'])
    expect(saved().sessions).toEqual([
      {
        provider: 'gemini',
        sessionId: 'session-a',
        paneKey: 'tab-9:1',
        paths: ['/w/old-a.md', '/w/new-a.md']
      }
    ])
    expect(saved().legacy).toEqual([
      { paneKey: 'tab-2:1', sessionId: null, paths: ['/w/unattributed.md'] },
      { paneKey: 'tab-3:1', sessionId: 'session-c', paths: ['/w/old-c.md'] }
    ])
  })

  it('still lists records by pane in the first release’s shape, the latest session per pane', () => {
    seedFirstRelease()
    const store = new SessionWrittenFilesStore({ directory })
    store.load()
    store.observe(write('/w/b.md', { paneKey: 'tab-3:1', providerSession: { id: 'session-b' } }))
    expect(store.listByPane()).toEqual([
      { paneKey: 'tab-1:1', sessionId: 'session-a', paths: ['/w/old-a.md'] },
      { paneKey: 'tab-2:1', sessionId: null, paths: ['/w/unattributed.md'] },
      { paneKey: 'tab-3:1', sessionId: 'session-b', paths: ['/w/b.md'] }
    ])
  })

  it('subscribes at start and serves the RPC until quit', async () => {
    let listener: ((event: ReturnType<typeof write>) => void) | null = null
    const unsubscribe = vi.fn()
    const stop = startSessionWrittenFiles({
      directory,
      subscribe: (next) => {
        listener = next
        return unsubscribe
      }
    })
    listener!(write('/w/a.md'))
    expect(getSessionWrittenFilesStore()?.pathsFor('gemini', 'session-a')).toEqual(['/w/a.md'])
    await stop()
    expect(unsubscribe).toHaveBeenCalled()
    expect(getSessionWrittenFilesStore()).toBeNull()
  })
})
