import type { TerminalHost } from './terminal-host'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import { SessionNotFoundError } from './types'

/** Both envelopes execute once, synchronously, in their received wire order. */
export function routePersonWrite(
  options: {
    host: Pick<TerminalHost, 'write' | 'writeAccepted'>
    attachments: Pick<DaemonSessionAttachments, 'recordInput' | 'clearInput'>
  },
  sessionId: string,
  data: string,
  requireAccepted: boolean,
  onMissing: () => void
): { accepted?: boolean } {
  try {
    options.attachments.recordInput(sessionId)
    if (requireAccepted) {
      const accepted = options.host.writeAccepted(sessionId, data)
      if (!accepted) {
        options.attachments.clearInput(sessionId)
      }
      return { accepted }
    }
    options.host.write(sessionId, data)
    return {}
  } catch (error) {
    options.attachments.clearInput(sessionId)
    if (error instanceof SessionNotFoundError) {
      onMissing()
    }
    throw error
  }
}
