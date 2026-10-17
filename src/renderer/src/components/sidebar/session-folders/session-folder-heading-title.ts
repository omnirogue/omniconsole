import { translate } from '@/i18n/i18n'
import type { SessionSidebarBatchOrigin } from '@/lib/session-sidebar-tree'

/** A folder heading's hover text: its path, and for a batch folder the words and time that launched it. */
export function sessionFolderHeadingTitle(
  path: string,
  origin: SessionSidebarBatchOrigin | undefined
): string {
  if (!origin) {
    return path
  }
  const launched = translate(
    'conversations.batchFolderOrigin',
    'Launched {{time}} from: “{{request}}”',
    {
      time: new Date(origin.createdAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
      request: origin.requestExcerpt
    }
  )
  return `${path}\n${launched}`
}
