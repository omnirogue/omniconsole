import { useCallback } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { resolveNativeChatFileLink, type NativeChatFileLinkContext } from './native-chat-file-link'
import { tryOpenSessionDocument } from '@/lib/session-document-routing'

export function useNativeChatFileLinkClick(
  context: NativeChatFileLinkContext | null
): CommentMarkdownLinkClickHandler | undefined {
  const openFileLink = useCallback<CommentMarkdownLinkClickHandler>(
    (event, href) => {
      if (
        href &&
        !event.shiftKey &&
        event.button !== 1 &&
        tryOpenSessionDocument(href, context?.worktreeId)
      ) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      const target = resolveNativeChatFileLink(href, context)
      if (!target || !context) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      openDetectedFilePath(target.absolutePath, target.line, target.column, {
        worktreeId: context.worktreeId,
        worktreePath: context.worktreePath,
        runtimeEnvironmentId: context.runtimeEnvironmentId,
        openWithSystemDefault: event.shiftKey
      })
    },
    [context]
  )
  return openFileLink
}
