import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SESSION_LINKED_DOCS_FILE,
  SESSION_LINKED_DOCS_MAX_CONVERSATIONS,
  SessionLinkedDocsStore
} from './session-linked-docs-store'

const SLITE = 'https://example.slite.com/app/docs/p7qESgZFFXYZsv'

describe('SessionLinkedDocsStore', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'linked-docs-'))
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('records a reply’s links per conversation and reads them back after a restart', async () => {
    const store = new SessionLinkedDocsStore({ directory, now: () => 10 })
    store.noteReply('tab-a:leaf', `The plan is at ${SLITE}`, null)
    store.noteReply('tab-b:leaf', 'No links in this reply.', null)
    await store.flush()
    const reloaded = new SessionLinkedDocsStore({ directory })
    reloaded.load()
    expect(reloaded.list()).toEqual([
      {
        paneKey: 'tab-a:leaf',
        docs: [{ kind: 'slite', id: 'p7qESgZFFXYZsv', url: SLITE, seenAt: 10 }]
      }
    ])
  })

  it('evicts the conversation linked longest ago past the cap', () => {
    const store = new SessionLinkedDocsStore({ directory, now: () => 1 })
    for (let index = 0; index <= SESSION_LINKED_DOCS_MAX_CONVERSATIONS; index++) {
      store.noteReply(`tab-${index}:leaf`, SLITE, null)
    }
    const keys = store.list().map((entry) => entry.paneKey)
    expect(keys).toHaveLength(SESSION_LINKED_DOCS_MAX_CONVERSATIONS)
    expect(keys).not.toContain('tab-0:leaf')
  })

  it('reads a damaged file as empty and drops malformed entries', () => {
    writeFileSync(join(directory, SESSION_LINKED_DOCS_FILE), '{not json')
    const broken = new SessionLinkedDocsStore({ directory })
    broken.load()
    expect(broken.list()).toEqual([])
    writeFileSync(
      join(directory, SESSION_LINKED_DOCS_FILE),
      JSON.stringify({ conversations: [{ paneKey: 'p', docs: [{ kind: 'nope' }] }, 7] })
    )
    const partial = new SessionLinkedDocsStore({ directory })
    partial.load()
    expect(partial.list()).toEqual([])
  })
})
