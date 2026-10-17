// Keep the original Dispatch recipient until the parent acknowledges its exact unread rows.
/** Mail addressed to a Dispatch of this Run that has already settled is read by the Run owner. */
export const SETTLED_DISPATCH_MAILBOX_SQL = `EXISTS (
  SELECT 1 FROM dispatch_contexts owner
  WHERE owner.id = substr(messages.to_handle, 10) AND messages.to_handle LIKE 'dispatch:%'
    AND owner.run_id = messages.run_id AND owner.status IN ('completed', 'failed', 'circuit_broken')
)`

export const RUN_MAILBOX_RECIPIENT_SQL = `(to_handle = ? OR ${SETTLED_DISPATCH_MAILBOX_SQL})`

export function mailboxRecipientPredicate(mailbox: string): { sql: string; params: string[] } {
  return mailbox.startsWith('run:')
    ? { sql: `run_id = ? AND ${RUN_MAILBOX_RECIPIENT_SQL}`, params: [mailbox.slice(4), mailbox] }
    : { sql: 'to_handle = ?', params: [mailbox] }
}
