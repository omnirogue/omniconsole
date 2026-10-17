import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

export function MenuItems({ label, children }: { label: string; children: ReactNode }) {
  const [focused, setFocused] = useState(0)
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
    )
    if (!items.length) {
      return
    }
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    setFocused(next)
    items[next]?.focus()
  }
  return (
    <div
      role="menu"
      aria-label={label}
      onKeyDown={keyDown}
      onFocusCapture={(event) => {
        const items = Array.from(event.currentTarget.querySelectorAll('[role^="menuitem"]'))
        const index = items.indexOf(event.target)
        if (index !== -1) {
          setFocused(index)
        }
      }}
      ref={(element) => {
        element
          ?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')
          .forEach((item, index) => {
            item.tabIndex = index === focused ? 0 : -1
          })
      }}
      className="space-y-1"
    >
      {children}
    </div>
  )
}

export function MenuItem({
  children,
  onChoose,
  onPreview,
  selected,
  review = false,
  label
}: {
  label?: string
  children: ReactNode
  onChoose: () => void
  onPreview?: () => void
  selected?: boolean
  review?: boolean
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      role={review ? 'menuitemcheckbox' : 'menuitem'}
      aria-label={label}
      aria-checked={review ? !!selected : undefined}
      data-current={selected || undefined}
      className="h-auto w-full justify-start whitespace-normal text-left text-xs data-[current=true]:bg-accent"
      onPointerEnter={onPreview}
      onFocus={onPreview}
      onClick={onChoose}
    >
      {review ? <span aria-hidden="true">{selected ? '☑' : '☐'}</span> : null}
      {children}
    </Button>
  )
}
