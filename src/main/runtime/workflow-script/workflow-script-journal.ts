import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * What an `agent()` call answered, by its content key. A run that meets a key it already
 * holds returns the answer without running the agent, which is how an edited script
 * re-runs only from its first changed call. Only successful answers are written.
 */
export type WorkflowScriptJournal = {
  get(key: string): Promise<{ value: unknown } | undefined>
  put(key: string, value: unknown): Promise<void>
}

export class MemoryWorkflowScriptJournal implements WorkflowScriptJournal {
  private readonly entries = new Map<string, unknown>()

  constructor(seed: Iterable<readonly [string, unknown]> = []) {
    for (const [key, value] of seed) {
      this.entries.set(key, value)
    }
  }

  get size(): number {
    return this.entries.size
  }

  async get(key: string): Promise<{ value: unknown } | undefined> {
    return this.entries.has(key) ? { value: this.entries.get(key) } : undefined
  }

  async put(key: string, value: unknown): Promise<void> {
    this.entries.set(key, value)
  }
}

type JournalLine = { key: string; value: unknown }

/**
 * One append-only JSONL file per run. Why append-only: a crash mid-write loses at most the
 * last line, which a re-run simply recomputes; nothing already journaled is ever rewritten.
 */
export class FileWorkflowScriptJournal implements WorkflowScriptJournal {
  private loaded: Promise<Map<string, unknown>> | null = null

  constructor(readonly filePath: string) {}

  private load(): Promise<Map<string, unknown>> {
    this.loaded ??= readFile(this.filePath, 'utf8')
      .then((contents) => {
        const entries = new Map<string, unknown>()
        for (const line of contents.split('\n')) {
          if (!line.trim()) {
            continue
          }
          try {
            const parsed = JSON.parse(line) as JournalLine
            if (typeof parsed.key === 'string') {
              entries.set(parsed.key, parsed.value)
            }
          } catch {
            // Why: a torn last line from a crash is recomputed, never treated as an answer.
          }
        }
        return entries
      })
      .catch(() => new Map<string, unknown>())
    return this.loaded
  }

  async get(key: string): Promise<{ value: unknown } | undefined> {
    const entries = await this.load()
    return entries.has(key) ? { value: entries.get(key) } : undefined
  }

  async put(key: string, value: unknown): Promise<void> {
    const entries = await this.load()
    entries.set(key, value)
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await appendFile(this.filePath, `${JSON.stringify({ key, value } satisfies JournalLine)}\n`)
  }
}
