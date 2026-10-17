// Why no type here: a row's `mirroredConversation` is step 6's `MirroredSidebarConversation`
// (mirrored-conversation-row-types.ts); this module only reads the keys the ledger gives rows.

/**
 * Whether a view key is a row the ledger created (F21: `['runtime:<env>', 'ledger', worktreeId,
 * <tagged identity>]`, `mirroredConversationRowKey`): only an owner-listed conversation is keyed so.
 */
export function isMirroredConversationLedgerKey(key: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(key)
  } catch {
    return false
  }
  return (
    Array.isArray(parsed) &&
    typeof parsed[0] === 'string' &&
    parsed[0].startsWith('runtime:') &&
    parsed[1] === 'ledger'
  )
}
