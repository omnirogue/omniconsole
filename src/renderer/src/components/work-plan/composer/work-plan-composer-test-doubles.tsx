import { Children, isValidElement, type ReactNode } from 'react'

/**
 * Test doubles for the two primitives whose real implementation is a portal and a focus trap.
 * They are shared so every composer test drives the SAME controls the dialog renders, instead of
 * each file inventing its own idea of what a select is.
 */
export function selectDouble() {
  return {
    Select: ({
      value,
      onValueChange,
      children
    }: {
      value: string
      onValueChange: (value: string) => void
      children: ReactNode
    }) => {
      let label: string | undefined
      Children.forEach(children, (child) => {
        const aria = isValidElement<{ 'aria-label'?: string }>(child)
          ? child.props['aria-label']
          : undefined
        if (aria) {
          label = aria
        }
      })
      return (
        <select
          aria-label={label}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
        >
          {children}
        </select>
      )
    },
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
      <option value={value}>{children}</option>
    )
  }
}

export function dialogDouble() {
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: ({ children, ...props }: { children: ReactNode; 'aria-label'?: string }) => (
      <div aria-label={props['aria-label']}>{children}</div>
    ),
    DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
    DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
  }
}
