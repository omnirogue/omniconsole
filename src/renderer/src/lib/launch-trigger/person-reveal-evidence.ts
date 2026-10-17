/**
 * Evidence that a person, not startup restore or automation, brought a terminal tab on
 * screen (latency telemetry, PR 1.0). The launch-trigger attribution reads it to tell
 * 'person-reveal' from 'cold-restore-mount' for an agent resumed in a visible pane.
 *
 * Rule: a tab counts as revealed by a person when it entered the foreground within
 * PERSON_REVEAL_INPUT_WINDOW_MS after a trusted pointer or key press in this window.
 * The tab that is on screen when the app starts has no press before it, so the cold
 * restore of the startup tab is not a person reveal; neither is a tab that automation
 * brings forward while nobody is touching the app.
 *
 * Telemetry only (load-bearing): nothing admits, delays or skips a launch on this.
 * It keeps one timestamp and a bounded tab id -> boolean map, never which key was
 * pressed or where, and it never throws. Leaf module: foreground-terminal-tabs.ts
 * calls it, so it must not import the store or any component.
 */

/** A press this long before a tab enters the foreground still counts as its cause.
 *  Both times are taken when the renderer handles them, so a busy renderer delays
 *  both and the gap stays short even during a restore flood. */
export const PERSON_REVEAL_INPUT_WINDOW_MS = 5_000
const MAX_TRACKED_TABS = 512

let lastPersonInputAt: number | null = null
const revealedByPersonByTabId = new Map<string, boolean>()
let uninstall: (() => void) | null = null

function nowMs(): number {
  return performance.now()
}

/** A person pressed a key or pointer in this window (handler time). */
export function notePersonInputForRevealEvidence(now?: number): void {
  try {
    const at = now ?? nowMs()
    if (Number.isFinite(at)) {
      lastPersonInputAt = at
    }
  } catch {
    // Diagnostics only.
  }
}

/** A terminal tab went from off screen to on screen. Decides, once per visit, whether a
 *  person caused it. */
export function noteTerminalTabEnteredForeground(tabId: string, now?: number): void {
  try {
    const at = now ?? nowMs()
    const byPerson =
      lastPersonInputAt !== null &&
      at >= lastPersonInputAt &&
      at - lastPersonInputAt <= PERSON_REVEAL_INPUT_WINDOW_MS
    revealedByPersonByTabId.delete(tabId)
    revealedByPersonByTabId.set(tabId, byPerson)
    while (revealedByPersonByTabId.size > MAX_TRACKED_TABS) {
      const oldest = revealedByPersonByTabId.keys().next()
      if (oldest.done) {
        break
      }
      revealedByPersonByTabId.delete(oldest.value)
    }
  } catch {
    // Diagnostics only.
  }
}

/** Whether a person brought this tab on screen for its current foreground visit. */
export function wasTerminalTabRevealedByPerson(tabId: string): boolean {
  return revealedByPersonByTabId.get(tabId) === true
}

type InputEventTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

const PERSON_INPUT_EVENTS = ['pointerdown', 'keydown'] as const

/**
 * Listens for a person's presses for the life of the renderer. Installed at renderer
 * bootstrap so a press that opens the first terminal is seen. Capture and passive: it
 * records a timestamp and never touches the event.
 */
export function installPersonRevealEvidence(
  target: InputEventTarget | undefined = typeof window === 'undefined' ? undefined : window
): () => void {
  if (!target || uninstall) {
    return () => {}
  }
  const options: AddEventListenerOptions = { capture: true, passive: true }
  const onInput = (event: Event): void => {
    // Why trusted only: a synthetic event dispatched by app code is not a person.
    if (event.isTrusted) {
      notePersonInputForRevealEvidence()
    }
  }
  for (const type of PERSON_INPUT_EVENTS) {
    target.addEventListener(type, onInput, options)
  }
  const remove = (): void => {
    for (const type of PERSON_INPUT_EVENTS) {
      target.removeEventListener(type, onInput, options)
    }
    if (uninstall === remove) {
      uninstall = null
    }
  }
  uninstall = remove
  return remove
}

export function resetPersonRevealEvidenceForTests(): void {
  uninstall?.()
  uninstall = null
  lastPersonInputAt = null
  revealedByPersonByTabId.clear()
}
