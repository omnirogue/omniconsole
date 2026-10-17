import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'

export function LocalWorkflowFollowUp({
  label,
  onSubmit,
  onNewTurn,
  newTurnLabel,
  disabled,
  autoFocus = false
}: {
  label: string
  onSubmit: (prompt: string) => Promise<void>
  onNewTurn?: () => void
  newTurnLabel?: string
  disabled?: boolean
  /** Opened on request ("Ask a follow-up"), so the cursor belongs in it. */
  autoFocus?: boolean
}) {
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const submitting = useRef(false)
  return (
    <form
      className="space-y-3 rounded-xl border bg-card p-3.5 shadow-xs"
      onSubmit={async (event) => {
        event.preventDefault()
        if (submitting.current || disabled || !prompt.trim()) {
          return
        }
        submitting.current = true
        setPending(true)
        setError(undefined)
        try {
          await onSubmit(prompt.trim())
          setPrompt('')
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          submitting.current = false
          setPending(false)
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label
          htmlFor="workflow-follow-up"
          className="rounded-full border px-2.5 py-1 text-xs font-normal"
        >
          {translate('localWorkflow.askModel', 'Ask {{label}}', { label })}
        </Label>
        {onNewTurn && newTurnLabel && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending || disabled}
            onClick={onNewTurn}
          >
            {newTurnLabel}
          </Button>
        )}
      </div>
      <Textarea
        id="workflow-follow-up"
        autoFocus={autoFocus}
        aria-label={translate('localWorkflow.followUpWith', 'Follow up with {{label}}', { label })}
        placeholder={translate('localWorkflow.askAboutResult', 'Ask about this result…')}
        className="min-h-16 resize-y border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        value={prompt}
        disabled={pending || disabled}
        maxLength={8_000}
        rows={2}
        onChange={(event) => setPrompt(event.target.value)}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end border-t pt-3">
        <Button type="submit" disabled={pending || disabled || !prompt.trim()}>
          {translate('localWorkflow.sendFollowUp', 'Send follow-up')}
        </Button>
      </div>
    </form>
  )
}
