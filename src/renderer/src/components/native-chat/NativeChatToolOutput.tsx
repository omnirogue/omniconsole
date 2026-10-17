import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { MAX_TOOL_DETAIL_LENGTH } from '../../../../shared/native-chat-tool-summary'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { NativeChatCheckPreview } from './NativeChatCheckPreview'
import { parseNativeChatCheckPreview } from './native-chat-check-preview'

export function NativeChatToolOutput({
  output,
  isError
}: {
  output: string
  isError?: boolean
}): React.JSX.Element {
  const checks = useMemo(
    () => (isError ? null : parseNativeChatCheckPreview(output)),
    [output, isError]
  )
  if (!checks) {
    return <NativeChatRawToolOutput output={output} isError={isError} />
  }
  return (
    <div className="space-y-1">
      <NativeChatCheckPreview checks={checks} />
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {translate('components.native-chat.tool.fullOutput', 'Full output')}
        </summary>
        <NativeChatRawToolOutput output={output} />
      </details>
    </div>
  )
}

/** Page the original output so inspecting evidence never mounts an unbounded text node. */
function NativeChatRawToolOutput({
  output,
  isError
}: {
  output: string
  isError?: boolean
}): React.JSX.Element {
  const [requestedPage, setRequestedPage] = useState(0)
  const pages = Math.max(1, Math.ceil(output.length / MAX_TOOL_DETAIL_LENGTH))
  const page = Math.min(requestedPage, pages - 1)
  const start = page * MAX_TOOL_DETAIL_LENGTH

  return (
    <div className="space-y-1">
      <pre
        className={cn(
          'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-accent p-2 font-mono text-[11px] scrollbar-sleek',
          isError ? 'text-destructive' : 'text-foreground/80'
        )}
      >
        {output.slice(start, start + MAX_TOOL_DETAIL_LENGTH)}
      </pre>
      {pages > 1 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span aria-live="polite">
            {translate(
              'components.native-chat.tool.outputPage',
              'Output page {{page}} of {{pages}}',
              { page: page + 1, pages }
            )}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={page === 0}
            onClick={() => setRequestedPage(page - 1)}
          >
            {translate('components.native-chat.tool.previousOutput', 'Previous output')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={page === pages - 1}
            onClick={() => setRequestedPage(page + 1)}
          >
            {translate('components.native-chat.tool.nextOutput', 'More output')}
          </Button>
          <NativeChatCopyButton
            text={output}
            label={translate('components.native-chat.tool.copyFullOutput', 'Copy full output')}
          />
        </div>
      ) : null}
    </div>
  )
}
