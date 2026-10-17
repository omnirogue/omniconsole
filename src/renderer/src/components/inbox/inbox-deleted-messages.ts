import { peerMessageProjects, peerMessageThreads } from '@/lib/peer-messages'
import { translate } from '@/i18n/i18n'
import type { PeerMessageThread } from '../../../../shared/peer-message-contract'

export async function readDeletedMessages(viewer: string, pages: number, current: () => boolean) {
  const assertCurrent = () => {
    if (!current()) {
      throw new Error(
        translate('workActions.viewerUnknown', 'Reopen this list to confirm your account.')
      )
    }
  }
  assertCurrent()
  const projects = await peerMessageProjects()
  assertCurrent()
  const messages = new Map<string, PeerMessageThread>()
  let more = false
  for (const project of projects) {
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let count = 0; count < pages; count += 1) {
      assertCurrent()
      const page = await peerMessageThreads(project.id, cursor, false, 'archived')
      assertCurrent()
      if (
        page.view !== 'archived' ||
        page.employee_id !== viewer ||
        page.threads.some(
          (message) =>
            message.archived !== true ||
            ![message.sender_employee_id, message.recipient_employee_id].includes(viewer)
        )
      ) {
        throw new Error(
          translate(
            'inbox.deletedUnconfirmed',
            'This server could not confirm your deleted messages.'
          )
        )
      }
      for (const message of page.threads) {
        messages.set(message.id, message)
      }
      if (!page.next_cursor) {
        break
      }
      if (seen.has(page.next_cursor)) {
        throw new Error(
          translate(
            'inbox.deletedPageRepeated',
            'Deleted messages could not be fully read. Refresh to try again.'
          )
        )
      }
      seen.add(page.next_cursor)
      cursor = page.next_cursor
      if (count === pages - 1) {
        more = true
      }
    }
  }
  return { messages: [...messages.values()], more }
}
