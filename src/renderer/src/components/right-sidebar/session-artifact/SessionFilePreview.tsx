import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-client'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { translate } from '@/i18n/i18n'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import type { SessionPanelItem } from './session-panel-items'

export function SessionFilePreview({
  item,
  visible
}: {
  item: Extract<SessionPanelItem, { kind: 'file' }>
  visible: boolean
}): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readAt, setReadAt] = useState<number | null>(null)
  useEffect(() => {
    if (!visible) {
      return
    }
    let disposed = false
    let pending = false
    const refresh = async () => {
      if (pending || document.visibilityState === 'hidden') {
        return
      }
      pending = true
      try {
        const environmentId = item.context.settings?.activeRuntimeEnvironmentId
        if (
          environmentId &&
          (item.context.expectedEnvironmentPairingRevision === undefined ||
            item.context.expectedEnvironmentPairingRevision !==
              getRuntimeEnvironmentRevision(environmentId))
        ) {
          setContent(null)
          throw new Error('The source runtime changed')
        }
        const result = await readRuntimeFilePreview(item.context, item.path)
        if (disposed) {
          return
        }
        if (result.isBinary || result.content.length > 2_000_000) {
          setError(
            translate('sessionPanel.fileUnsupported', 'Open this file in the editor to view it.')
          )
          setContent(null)
        } else {
          setContent(result.content)
          setError(null)
          setReadAt(Date.now())
        }
      } catch {
        if (!disposed) {
          setError(
            translate(
              'sessionPanel.fileUnavailable',
              'File unavailable on its source host. The last preview may be stale.'
            )
          )
        }
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 3_000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [item, visible])
  const html = /\.html?$/i.test(item.path)
  const markdown = /\.(md|markdown)$/i.test(item.path)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b p-2 text-xs">
        <span className="min-w-0 flex-1 truncate" title={item.path}>
          {item.path.split(/[\\/]/).at(-1)}
        </span>
        <span className="text-muted-foreground">
          {readAt ? new Date(readAt).toLocaleTimeString() : ''}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            openDetectedFilePath(item.path, 1, null, {
              worktreeId: item.context.worktreeId ?? '',
              worktreePath: item.context.worktreePath ?? '',
              runtimeEnvironmentId: item.context.settings?.activeRuntimeEnvironmentId
            })
          }
        >
          {translate('sessionPanel.openEditor', 'Open in editor')}
        </Button>
      </div>
      {error ? (
        <p role="status" className="border-b p-3 text-xs text-muted-foreground">
          {error}
        </p>
      ) : null}
      {content === null ? (
        <p className="p-3 text-xs text-muted-foreground">
          {error ? '' : translate('sessionPanel.loading', 'Loading…')}
        </p>
      ) : html ? (
        <iframe
          title={item.path}
          sandbox=""
          className="min-h-0 flex-1 border-0 bg-background"
          srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">${
            content
          }`}
        />
      ) : (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-4">
          {markdown ? (
            <CommentMarkdown content={content} variant="document" remoteImages="link" />
          ) : (
            <pre className="whitespace-pre-wrap break-words text-xs">{content}</pre>
          )}
        </div>
      )}
    </div>
  )
}
