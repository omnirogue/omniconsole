import type { TerminalTab } from './terminal-tab-types'

/**
 * The owner's sidebar name for one pane, in the owner sidebar's own order: a rename, the pane's
 * title, then the generated or agent title. Never the live terminal title: a paired computer reads
 * that from the terminal itself, and it would otherwise outrank the rename it is meant to carry.
 */
export function sessionOwnerTitle(
  tab: Pick<TerminalTab, 'customTitle' | 'generatedTitle' | 'aiVaultTitle'>,
  paneTitle: string | null | undefined
): string | undefined {
  return (
    tab.customTitle?.trim() ||
    paneTitle?.trim() ||
    tab.generatedTitle?.trim() ||
    tab.aiVaultTitle?.title.trim() ||
    undefined
  )
}

/** Additive wire field: old owners omit it, so the paired computer keeps its own fallbacks. */
export function readSessionOwnerTitle(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
