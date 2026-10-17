/**
 * The Slite docs and omnios pages each conversation linked in its replies, on this host's disk only,
 * so the right panel can show a conversation's newest plan after a restart. Holds at most
 * `SESSION_LINKED_DOCS_MAX_CONVERSATIONS` conversations (least recently linked out first) and
 * `SESSION_LINKED_DOCS_PER_CONVERSATION` documents each.
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  extractSessionLinkedDocs,
  mergeSessionLinkedDocs,
  sanitizeSessionLinkedDoc,
  type SessionLinkedDoc
} from '../../shared/session-linked-docs'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

export const SESSION_LINKED_DOCS_FILE = 'session-linked-docs.json'
export const SESSION_LINKED_DOCS_MAX_CONVERSATIONS = 500
export const SESSION_LINKED_DOCS_PER_CONVERSATION = 20

export class SessionLinkedDocsStore {
  private conversations = new Map<string, SessionLinkedDoc[]>()
  private writeChain: Promise<void> = Promise.resolve()
  private writeQueued = false

  constructor(
    private readonly options: {
      directory: string
      now?: () => number
    }
  ) {}

  private get path(): string {
    return join(this.options.directory, SESSION_LINKED_DOCS_FILE)
  }

  load(): void {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return
    }
    const entries = (raw as { conversations?: unknown })?.conversations
    if (!Array.isArray(entries)) {
      return
    }
    const restored = new Map<string, SessionLinkedDoc[]>()
    for (const entry of entries.slice(-SESSION_LINKED_DOCS_MAX_CONVERSATIONS)) {
      const paneKey = (entry as { paneKey?: unknown })?.paneKey
      const docs = (entry as { docs?: unknown })?.docs
      if (
        typeof paneKey !== 'string' ||
        !paneKey ||
        paneKey.length > 4_096 ||
        !Array.isArray(docs)
      ) {
        continue
      }
      const valid = docs
        .map(sanitizeSessionLinkedDoc)
        .filter((doc): doc is SessionLinkedDoc => doc !== null)
      if (valid.length > 0) {
        restored.set(
          paneKey,
          mergeSessionLinkedDocs([], valid, SESSION_LINKED_DOCS_PER_CONVERSATION)
        )
      }
    }
    this.conversations = restored
  }

  /** Records the documents one finished reply links to; a reply without links changes nothing. */
  noteReply(paneKey: string, reply: string, apiOrigin: string | null): void {
    if (!paneKey || !reply) {
      return
    }
    const added = extractSessionLinkedDocs(reply, apiOrigin, (this.options.now ?? Date.now)())
    if (added.length === 0) {
      return
    }
    const merged = mergeSessionLinkedDocs(
      this.conversations.get(paneKey) ?? [],
      added,
      SESSION_LINKED_DOCS_PER_CONVERSATION
    )
    // Why delete first: Map order is insertion order, so the latest-linked conversation is last.
    this.conversations.delete(paneKey)
    this.conversations.set(paneKey, merged)
    while (this.conversations.size > SESSION_LINKED_DOCS_MAX_CONVERSATIONS) {
      const oldest = this.conversations.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.conversations.delete(oldest)
    }
    this.persist()
  }

  list(): { paneKey: string; docs: SessionLinkedDoc[] }[] {
    return [...this.conversations].map(([paneKey, docs]) => ({ paneKey, docs: [...docs] }))
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  private persist(): void {
    if (this.writeQueued) {
      return
    }
    this.writeQueued = true
    const finalPath = this.path
    this.writeChain = this.writeChain
      .then(async () => {
        this.writeQueued = false
        const payload = JSON.stringify({ version: 1, conversations: this.list() })
        await mkdir(this.options.directory, { recursive: true })
        await writeFileDurable(durableWriteTempPath(finalPath), finalPath, payload)
      })
      .catch((error: unknown) => {
        console.error(`[session-linked-docs] saving ${finalPath} failed`, error)
      })
  }
}

let activeStore: SessionLinkedDocsStore | null = null

export function setSessionLinkedDocsStore(store: SessionLinkedDocsStore | null): void {
  activeStore = store
}

export function getSessionLinkedDocsStore(): SessionLinkedDocsStore | null {
  return activeStore
}
