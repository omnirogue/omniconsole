import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TranscriptSequenceStore } from './transcript-sequence-store'

describe('TranscriptSequenceStore', () => {
  it('continues a session sequence across instances and never reuses a number', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seq-store-'))
    const first = new TranscriptSequenceStore(directory)
    await first.load()
    expect(first.peek('claude', 'ses-1')).toBe(1)
    first.commit('claude', 'ses-1', 1)
    first.commit('claude', 'ses-1', 2)
    first.commit('claude', 'ses-1', 1)
    await first.flush()
    const stored = JSON.parse(
      await readFile(join(directory, 'session-sync-sequences.json'), 'utf8')
    ) as Record<string, number>
    expect(Object.values(stored)).toEqual([2])
    expect(Object.keys(stored)[0]).toContain('ses-1')

    const second = new TranscriptSequenceStore(directory)
    await second.load()
    expect(second.peek('claude', 'ses-1')).toBe(3)
    expect(second.peek('codex', 'ses-1')).toBe(1)
  })

  it('works in memory without a directory', async () => {
    const store = new TranscriptSequenceStore(null)
    await store.load()
    store.commit('grok', 's', 1)
    await store.flush()
    expect(store.peek('grok', 's')).toBe(2)
  })
})
