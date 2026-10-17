import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * `FreshPaneEvidence` kept across app runs: each pane seen starting fresh, and whether anything
 * (a hook event, typed input, a turn, a lost POST) has reached it since. Written at once on every
 * such change, so a restart never forgets a keystroke. `createdAt` is when this file first
 * existed: a start older than it was never watched here.
 */

export const FRESH_PANE_EVIDENCE_FILE = 'fresh-panes.json'
const VERSION = 1
/** The spool's own horizon; an older start has no hook evidence left to check it against. */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000
const MAX_PANES = 500

export type StoredFreshPane = {
  startedAt: number
  providerSessionId: string | null
  worktreeId: string | null
  agentPid: number | null
  agent: string | null
  touched: boolean
  /** Seeded from a hook row older than this file: no keystroke before the file was seen. */
  legacy?: true
}

export type StoredFreshPanes = { createdAt: number; panes: Record<string, StoredFreshPane> }

export type FreshPaneEvidenceStorage = {
  load: () => StoredFreshPanes
  save: (panes: Record<string, StoredFreshPane>) => void
}

const nullableString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function readPane(raw: unknown): StoredFreshPane | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const pane = raw as Record<string, unknown>
  if (typeof pane.startedAt !== 'number' || typeof pane.touched !== 'boolean') {
    return null
  }
  return {
    startedAt: pane.startedAt,
    providerSessionId: nullableString(pane.providerSessionId),
    worktreeId: nullableString(pane.worktreeId),
    agentPid: typeof pane.agentPid === 'number' ? pane.agentPid : null,
    agent: nullableString(pane.agent),
    touched: pane.touched,
    ...(pane.legacy === true ? { legacy: true as const } : {})
  }
}

export class FreshPaneEvidenceStore implements FreshPaneEvidenceStorage {
  private createdAt = 0

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * A missing file starts one now; an unreadable or foreign one vouches for nothing (created at
   * 0, so no older start is seeded and no pane is carried over).
   */
  load(): StoredFreshPanes {
    const loaded = this.read()
    this.createdAt = loaded.createdAt
    return loaded
  }

  save(panes: Record<string, StoredFreshPane>): void {
    const cutoff = this.now() - MAX_AGE_MS
    const kept = Object.entries(panes)
      .filter(([, pane]) => pane.startedAt >= cutoff)
      .sort(([, a], [, b]) => b.startedAt - a.startedAt)
      .slice(0, MAX_PANES)
    this.write({ createdAt: this.createdAt, panes: Object.fromEntries(kept) })
  }

  private read(): StoredFreshPanes {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        return { createdAt: 0, panes: {} }
      }
      const created = { createdAt: this.now(), panes: {} }
      this.write(created)
      return created
    }
    try {
      const file = JSON.parse(text) as Record<string, unknown>
      if (file.version !== VERSION || typeof file.createdAt !== 'number') {
        return { createdAt: 0, panes: {} }
      }
      const panes: Record<string, StoredFreshPane> = {}
      for (const [paneKey, raw] of Object.entries((file.panes ?? {}) as Record<string, unknown>)) {
        const pane = readPane(raw)
        if (!pane) {
          return { createdAt: 0, panes: {} }
        }
        panes[paneKey] = pane
      }
      return { createdAt: file.createdAt, panes }
    } catch {
      return { createdAt: 0, panes: {} }
    }
  }

  private write(file: StoredFreshPanes): void {
    const temp = `${this.path}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      writeFileSync(temp, JSON.stringify({ version: VERSION, ...file }), { mode: 0o600 })
      renameSync(temp, this.path)
    } catch (error) {
      // Why remove it: a file that missed a touch must not vouch for that pane after a restart.
      console.warn('[fresh-pane-evidence] could not save; the evidence file is dropped', error)
      for (const path of [temp, this.path]) {
        try {
          unlinkSync(path)
        } catch {
          // Nothing more can be done; a missing file vouches only for older, transcript-checked starts.
        }
      }
    }
  }
}
