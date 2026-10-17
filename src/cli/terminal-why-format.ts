import type { RuntimeTerminalWhy } from '../shared/launch-ledger'

export function formatTerminalWhy(value: { why: RuntimeTerminalWhy }): string {
  const previous = value.why.previousCreations ?? []
  const history = previous.length
    ? ` Previous process creation history: ${previous.map((row) => `${row.cause.replaceAll('-', ' ')} at ${row.ts}`).join('; ')}.`
    : ''
  if (value.why.currentStartUnrecorded) {
    return `This process was started by a request whose outcome was not recorded.${history}`
  }
  const row = value.why.launch
  if (!row) {
    return 'No launch record for this terminal in the retained ledger.'
  }
  const cause = row.cause === 'unknown' ? 'an unreported cause' : row.cause.replaceAll('-', ' ')
  const actor = row.actor
  const who = actor
    ? [actor.kind, actor.deviceId, actor.paneKey, actor.terminalHandle].filter(Boolean).join(' ')
    : 'an unspecified caller'
  const owner = Object.entries(row.reference ?? {})
    .map(([key, id]) => `${key} ${id}`)
    .join(', ')
  const claimed = [
    row.claimedTrigger
      ? `claimed cause ${row.claimedTrigger.replaceAll('-', ' ')}`
      : row.claimedTriggerHash
        ? `claimed cause hash ${row.claimedTriggerHash}`
        : '',
    ...Object.entries(row.claimedReferenceHashes ?? {}).map(([key, id]) => `claimed ${key} ${id}`)
  ]
    .filter(Boolean)
    .join('; ')
  const claims =
    actor?.unverifiedPaneKey || actor?.unverifiedTerminalHandle
      ? `; unverified caller claims ${[actor.unverifiedPaneKey, actor.unverifiedTerminalHandle].filter(Boolean).join(' ')}`
      : ''
  const action =
    row.process === 'prepared' || row.process === 'attachment-intent'
      ? 'was requested; outcome not recorded'
      : row.process === 'attached'
        ? 'attached to an existing process'
        : row.process === 'failed'
          ? 'failed before execution'
          : row.process === 'unknown'
            ? 'was requested; outcome unknown'
            : 'started'
  const attachments = value.why.attachments ?? []
  const later = attachments.length
    ? ` Later attachment requests: ${attachments.length}; latest ${attachments.at(-1)?.process.replaceAll('-', ' ')} at ${attachments.at(-1)?.ts}.`
    : ''
  return `This terminal ${action} for ${cause}, requested by ${who} at ${row.ts}${owner ? ` (${owner})` : ''}${claims}${claimed ? `; ${claimed}` : ''}.${later}${history}`
}
