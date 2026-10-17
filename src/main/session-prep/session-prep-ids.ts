import { randomBytes } from 'node:crypto'

function randomBase36(length: number): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  return [...randomBytes(length)].map((byte) => alphabet[byte % 36]).join('')
}

export function createSessionPrepBatchId(now: number): string {
  return `sp_${now.toString(36)}${randomBase36(6)}`
}

export function createSessionPrepOperationId(now: number): string {
  return `${now}-${randomBytes(16).toString('hex')}`
}

export function sessionPrepTitleSlug(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'item'
}

/** Unique per item: two items in one batch can share a title, and resume matches by this name. */
export function sessionPrepWorktreeName(title: string, batchId: string, index: number): string {
  const suffix = batchId.replace(/^sp_/, '').slice(-4)
  return `rp-${sessionPrepTitleSlug(title)}-${suffix}-${index + 1}`
}

// Why: a CLI prints its warnings first and the reason it failed last; a clipped head hid
// "Failed to authenticate" behind settings warnings. Keep the line that says what went wrong.
const FAILURE_REASON =
  /(failed to authenticate[^.]*|oauth[^.]*(?:expired|invalid|revoked)[^.]*|not logged in[^.]*|please run \/login[^.]*|usage limit[^.]*|credit balance[^.]*|error: [^.]*)/i

export function shortSessionPrepReason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim()
  if (text.length <= 160) {
    return text || 'unknown error'
  }
  const reason = FAILURE_REASON.exec(text)?.[0]
  return (reason ?? `${text.slice(0, 60)} … ${text.slice(-95)}`).slice(0, 160)
}

// Why: a lapsed sign-in fails the session launch as well, so a session started on it dies at once.
const SIGN_IN_FAILURE =
  /failed to authenticate|oauth session expired|not logged in|please run \/login|invalid api key|authentication_error/i

export function isSessionPrepSignInFailure(error: unknown): boolean {
  return SIGN_IN_FAILURE.test(error instanceof Error ? error.message : String(error))
}

// Environment preparation failed before a helper could run; another dependent call cannot repair it.
export class SessionPrepAccountPreparationError extends Error {}

export function isSessionPrepAccountFailure(error: unknown): boolean {
  return error instanceof SessionPrepAccountPreparationError || isSessionPrepSignInFailure(error)
}
