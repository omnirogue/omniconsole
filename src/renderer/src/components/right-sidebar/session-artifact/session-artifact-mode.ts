/**
 * Whether the open right panel shows Session work: only with a session on screen, and only while
 * the person has not picked a developer tab instead. Nothing here ever opens the panel.
 */
export function isArtifactModeActive(preferred: boolean, hasSession: boolean): boolean {
  return hasSession && preferred
}

/** The item the person picked if it is still the session's, else the most recent one. */
export function pickSessionArtifact<T extends { key: string }>(
  items: readonly T[],
  pickedKey: string | null
): T | null {
  if (pickedKey) {
    const picked = items.find((item) => item.key === pickedKey)
    if (picked) {
      return picked
    }
  }
  return items[0] ?? null
}
