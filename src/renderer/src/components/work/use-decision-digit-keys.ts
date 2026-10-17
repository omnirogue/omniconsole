import { useEffect, type RefObject } from 'react'
import { usePaneKeyboardEnabled } from '@/components/pane-focus-context'

function typingInto(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return (
    !!element &&
    (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))
  )
}

/**
 * 1–9 picks that option of the Decisions box's question card, as a click would (single choice
 * sends at once; several choices toggle and wait for Submit). Only while the Work page shows the
 * box, and never while the person is typing somewhere.
 */
export function useDecisionDigitKeys(box: RefObject<HTMLElement | null>): void {
  const keyboardEnabled = usePaneKeyboardEnabled()
  useEffect(() => {
    if (!keyboardEnabled) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || typingInto(event.target)) {
        return
      }
      const digit = Number(event.key)
      const container = box.current
      if (!container || !Number.isInteger(digit) || digit < 1 || digit > 9) {
        return
      }
      if (!container.isConnected || container.getClientRects().length === 0) {
        return
      }
      const option =
        container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[digit - 1]
      if (option && !option.disabled) {
        event.preventDefault()
        option.click()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [box, keyboardEnabled])
}
