import { useId, useState } from 'react'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { upNextDiagnosticText } from './up-next-refusal'

/**
 * Technical text — a watchdog's sentence, a startup blocker id, a provider error — folded behind
 * "Details". It is never a headline and never decides a state: the line above it already said
 * what the run is doing, in the person's words (`docs/reference/session-run-lifecycle.md`).
 */
export function UpNextDiagnostic({
  text,
  code,
  scope
}: {
  text?: string
  /** The machine code of the block, shown beside the prose for a bug report. */
  code?: string
  /** Which disclosure this is (`header`, `stage`), for the data attribute. */
  scope: string
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  if (!text && !code) {
    return null
  }
  return (
    <div className="min-w-0" data-up-next-diagnostic={scope}>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="h-5 gap-0.5 px-1 text-xs text-muted-foreground"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        {t('upNext.details', 'Details')}
        <span aria-hidden>{open ? '▴' : '▾'}</span>
      </Button>
      {open && (
        <div id={bodyId} className="min-w-0 space-y-0.5 pl-1 text-xs text-muted-foreground">
          {text && (
            <p className="min-w-0 whitespace-pre-wrap break-words" data-up-next-diagnostic-text>
              {upNextDiagnosticText(text)}
            </p>
          )}
          {code && (
            <p className="min-w-0 break-words font-mono text-[11px]" data-up-next-diagnostic-code>
              {code}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
