import { useCallback, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'

/** The conversation name as a field in place: Enter or clicking away saves, Esc cancels. */
export function ConversationRenameField({
  title,
  onRename,
  onDone
}: {
  title: string
  /** An empty name returns to the generated one. */
  onRename: (title: string | null) => void
  /** `fromKeyboard` asks the row to take focus back; a click away leaves focus where it went. */
  onDone: (fromKeyboard: boolean) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(title)
  // Why: Enter unmounts the field, and the blur that follows must not save a second time.
  const settledRef = useRef(false)
  const finish = (save: boolean, fromKeyboard: boolean): void => {
    if (settledRef.current) {
      return
    }
    settledRef.current = true
    const trimmed = draft.trim()
    if (save && trimmed !== title) {
      onRename(trimmed.length > 0 ? trimmed : null)
    }
    onDone(fromKeyboard)
  }
  const focusAndSelect = useCallback((input: HTMLInputElement | null) => {
    input?.focus()
    input?.select()
  }, [])
  const stop = (event: React.SyntheticEvent): void => event.stopPropagation()
  return (
    <Input
      ref={focusAndSelect}
      value={draft}
      spellCheck={false}
      aria-label={translate('conversations.renameAria', 'Rename {{title}}', { title })}
      placeholder={translate('conversations.renamePlaceholder', 'Use the generated name')}
      data-conversation-rename-input=""
      // Why the negative margin: the field sits in the title's line box, so the row does not grow while editing.
      className="-my-0.5 h-6 rounded-sm px-1.5 py-0 text-[13px] shadow-none focus-visible:ring-2 md:text-[13px]"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true, false)}
      onClick={stop}
      onDoubleClick={stop}
      onPointerDown={stop}
      onKeyDown={(event) => {
        event.stopPropagation()
        // Why: the Enter that only confirms an IME candidate must not save a half-typed name.
        if (isImeCompositionKeyDown(event)) {
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(true, true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(false, true)
        }
      }}
    />
  )
}
