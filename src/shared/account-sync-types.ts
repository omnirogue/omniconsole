/**
 * Session organization that follows the person's OmniConsole account: stored in omnios' per-person
 * preferences (`/api/gtd/prefs`), one key per document, under this prefix only.
 */
export const ACCOUNT_SYNC_KEY_PREFIX = 'omni-ide.sync.'
/** omnios' own key rule, narrowed to this app's prefix. */
export const ACCOUNT_SYNC_KEY = /^omni-ide\.sync\.[a-z0-9_.:-]{1,60}$/
/** omnios refuses a preference value whose `json.dumps` is over 32,000 characters. */
export const ACCOUNT_SYNC_VALUE_MAX_BYTES = 32_000

/**
 * At least the length omnios measures: Python's `json.dumps` writes every non-ASCII character as
 * `\uXXXX` (two for one outside the BMP) and a space after each `:` and `,`. Every `:` and `,`
 * counts, even inside strings, so this never under-counts.
 */
export function accountSyncValueSize(value: unknown): number {
  const json = JSON.stringify(value)
  if (json === undefined) {
    return Number.POSITIVE_INFINITY
  }
  let size = 0
  for (const char of json) {
    const code = char.codePointAt(0)!
    size += code < 0x80 ? (char === ':' || char === ',' ? 2 : 1) : code > 0xffff ? 12 : 6
  }
  return size
}

export type AccountSyncReadResult =
  | { ok: true; user: string; prefs: Record<string, unknown> }
  | { ok: false; message: string }

export type AccountSyncWriteArgs = { key: string; value: unknown; expectedUser: string }

export type AccountSyncWriteResult =
  | { ok: true }
  | { ok: false; message: string; accountChanged?: true }

/** The preload surface: session folders that follow the account (omnios per-person preferences). */
export type AccountSyncApi = {
  accountSyncRead: () => Promise<AccountSyncReadResult>
  accountSyncWrite: (args: AccountSyncWriteArgs) => Promise<AccountSyncWriteResult>
}
