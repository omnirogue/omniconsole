import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

/** Monospace text with a copy button; `shown` may abbreviate what is copied. */
export function EvolveCopyText({
  value,
  shown,
  label,
  className
}: {
  value: string
  shown?: string
  /** What the copy button copies, for its accessible name. */
  label: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), 1_500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2',
        className
      )}
    >
      <code className="min-w-0 truncate font-mono text-xs" title={value}>
        {shown ?? value}
      </code>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={translate('evolve.copy', 'Copy {{what}}', { what: label })}
        onClick={() => {
          // Why Electron's clipboard IPC: navigator.clipboard fails without window focus.
          void window.api.ui.writeClipboardText(value)
          setCopied(true)
          toast.success(translate('evolve.copied', 'Copied {{what}}', { what: label }))
        }}
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3" />
        ) : (
          <Copy aria-hidden="true" className="size-3" />
        )}
      </Button>
    </span>
  )
}
