import { useRef, useState, type KeyboardEvent } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

export type WorkPlanComposerBarProps = {
  prompt?: string
  onPromptChange?: (prompt: string) => void
  disabled?: boolean
  onNativeSend: (prompt: string) => unknown
}

/**
 * A prompt and Send, and nothing else. The mode checkbox, shape selector, outcome editor and
 * chain preview were removed on 2026-09-18 (Sal): the Up next composer is the one place a
 * pursuit is authored (templates, shapes under Advanced, Custom/Saved workflow), so this bar
 * only ever hands the typed line to the surface's own send. A surface that already has a
 * native composer does not mount it at all.
 *
 * One row: the field grows from one line to six with its text (field-sizing, no measure pass)
 * and Send sits inline at its right. Enter sends, Shift+Enter breaks the line; the placeholder
 * says so. What Send does is the surface's business and is unchanged.
 */
export function WorkPlanComposerBar({
  prompt: suppliedPrompt,
  onPromptChange,
  disabled,
  onNativeSend
}: WorkPlanComposerBarProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const prompt = suppliedPrompt ?? draft
  const submit = async (): Promise<void> => {
    if (disabled || busy.current) {
      return
    }
    busy.current = true
    setPending(true)
    setNotice('')
    try {
      const result = await onNativeSend(prompt)
      if (result !== false && suppliedPrompt === undefined) {
        setDraft('')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Why the composition guard: Enter that commits an IME candidate is not a send.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return
    }
    event.preventDefault()
    void submit()
  }
  const hint = translate(
    'workPlan.promptHint',
    'Prompt · Enter to send, Shift+Enter for a new line'
  )
  return (
    <div className="space-y-2" data-work-plan-composer>
      <div className="flex items-end gap-2">
        <Textarea
          aria-label={translate('workPlan.prompt', 'Prompt')}
          placeholder={hint}
          title={hint}
          rows={1}
          className="min-h-8 max-h-[calc(6lh_+_1rem)] flex-1 resize-none py-1.5 text-sm [field-sizing:content]"
          value={prompt}
          onChange={(event) => {
            setDraft(event.target.value)
            onPromptChange?.(event.target.value)
          }}
          onKeyDown={onKeyDown}
        />
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          disabled={disabled || pending}
          onClick={() => void submit()}
        >
          {translate('workPlan.send', 'Send')}
        </Button>
      </div>
      {notice ? (
        <p role="alert" className="text-xs text-destructive">
          {notice}
        </p>
      ) : null}
    </div>
  )
}
