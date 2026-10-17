import { useEffect, useId, useRef, useState } from 'react'

/** Attention actions must reveal the add controls before trying to focus them. */
export function useUpNextAddDisclosure(compact: boolean) {
  const [open, setOpen] = useState(false)
  const [focusRequested, setFocusRequested] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open || !focusRequested) {
      return
    }
    ref.current?.scrollIntoView?.({ block: 'nearest' })
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    setFocusRequested(false)
  }, [open, focusRequested])
  return {
    open,
    setOpen,
    ref,
    id,
    focus: () => {
      if (!compact || open) {
        ref.current?.scrollIntoView?.({ block: 'nearest' })
        ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
      } else {
        setOpen(true)
        setFocusRequested(true)
      }
    }
  }
}
