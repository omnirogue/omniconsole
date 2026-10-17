import React from 'react'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

/** The exact text Start sends, inspectable and copyable. */
export function AssistedBriefPromptView({ prompt }: { prompt: string }): React.JSX.Element {
  const copy = (): void => {
    void window.api.ui
      .writeClipboardText(prompt)
      .then(() => toast.success(translate('assistedBrief.promptCopied', 'Prompt copied')))
      .catch(() => toast.error(translate('assistedBrief.copyFailed', 'Could not copy the prompt')))
  }
  return (
    <details className="rounded-md border border-border px-2 py-1.5" data-brief-prompt="">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {translate('assistedBrief.showPrompt', 'Full prompt that Start sends')}
      </summary>
      <div className="mt-1.5 space-y-1.5">
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-[11px] scrollbar-sleek">
          {prompt}
        </pre>
        <Button type="button" variant="outline" size="xs" onClick={copy}>
          <Copy />
          {translate('assistedBrief.copyPrompt', 'Copy prompt')}
        </Button>
      </div>
    </details>
  )
}
