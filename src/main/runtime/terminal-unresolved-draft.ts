import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { WriteFence } from '../pty/guarded-pty-write'
import { dirname, join } from 'node:path'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'

export const UNRESOLVED_DRAFT_REASON =
  "Unsent text left in this session's input box — resolve it in the terminal and submit it yourself before another automated send."

const revisions = new Map<string, number>()
export const terminalDraftRevision = (ptyId: string): number => revisions.get(ptyId) ?? 0

const active = new Map<string, { owner: string; invalidators: Set<() => void> }>()

function draftPath(ptyId: string): string {
  return join(
    getProfileUserDataPath(),
    'terminal-unsent-drafts',
    createHash('sha256').update(ptyId).digest('hex')
  )
}

export function hasUnresolvedDraft(ptyId: string): boolean {
  try {
    statSync(draftPath(ptyId))
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

export function assertNoUnresolvedDraft(ptyId: string, owner?: string): void {
  if (owner && active.get(ptyId)?.owner === owner) {
    return
  }
  if (hasUnresolvedDraft(ptyId)) {
    throw new Error(UNRESOLVED_DRAFT_REASON)
  }
}

/** Persist before the first byte; a main-process crash must leave the terminal quarantined. */
export function beginTerminalDraft(ptyId: string): string {
  assertNoUnresolvedDraft(ptyId)
  const owner = randomUUID()
  const file = draftPath(ptyId)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, owner, { flag: 'wx', mode: 0o600 })
  revisions.set(ptyId, terminalDraftRevision(ptyId) + 1)
  active.set(ptyId, { owner, invalidators: new Set() })
  return owner
}

export function markUnresolvedDraft(ptyId: string): void {
  revisions.set(ptyId, terminalDraftRevision(ptyId) + 1)
  const draft = active.get(ptyId)
  active.delete(ptyId)
  for (const invalidate of draft?.invalidators ?? []) {
    invalidate()
  }
}

export function terminalDraftWriteFence(ptyId: string, owner: string): WriteFence {
  return {
    token: owner,
    isRevoked: () => active.get(ptyId)?.owner !== owner,
    onClose: (invalidate) => {
      const draft = active.get(ptyId)
      if (draft?.owner !== owner) {
        invalidate()
        return () => {}
      }
      draft.invalidators.add(invalidate)
      return () => {
        draft.invalidators.delete(invalidate)
      }
    }
  }
}

/** Call only after confirmed submission, an explicit reconciliation, or terminal destruction. */
export function clearUnresolvedDraft(ptyId: string): void {
  markUnresolvedDraft(ptyId)
  try {
    unlinkSync(draftPath(ptyId))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  active.delete(ptyId)
}

export function withUnresolvedDraftNote(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(UNRESOLVED_DRAFT_REASON)
    ? error instanceof Error
      ? error
      : new Error(message)
    : new Error(`${message} ${UNRESOLVED_DRAFT_REASON}`, { cause: error })
}
