import { LAUNCH_INTENT_DRAG_TYPE } from '../../../shared/session-sidebar-drag-types'
import {
  LAUNCHER_PROVIDERS,
  type LauncherProvider
} from '@/components/sidebar/session-folders/new-conversation/resolve-launch-plan'

export { LAUNCH_INTENT_DRAG_TYPE }
export type LaunchIntent = { agent: LauncherProvider }

// Dragover cannot read dataTransfer payloads; changing React state cancels a Chromium dragstart.
let inFlight: { owner: symbol; intent: LaunchIntent } | null = null

// Why: the source icon can unmount mid-drag (its provider stops being usable), and a detached
// node's dragend never reaches React. Any drop, dragend or Escape anywhere ends the drag.
const TERMINAL_EVENTS = ['drop', 'dragend', 'keydown'] as const
function onTerminalEvent(event: Event): void {
  if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') {
    return
  }
  clearLaunchIntentDrag()
}

/** Starts a launch-intent drag; the returned owner clears only its own drag. */
export function beginLaunchIntentDrag(
  data: Pick<DataTransfer, 'setData'>,
  intent: LaunchIntent
): symbol {
  data.setData(LAUNCH_INTENT_DRAG_TYPE, JSON.stringify(intent))
  const owner = Symbol('launch-intent-drag')
  if (!inFlight && typeof window !== 'undefined') {
    // Why capture: sidebar drop targets stop propagation; the payload, not this state, is read on drop.
    for (const type of TERMINAL_EVENTS) {
      window.addEventListener(type, onTerminalEvent, true)
    }
  }
  inFlight = { owner, intent }
  return owner
}

export function getLaunchIntentDrag(): LaunchIntent | null {
  return inFlight?.intent ?? null
}

/** Ends the in-flight drag; given an owner, only if that owner's drag is still the one in flight. */
export function clearLaunchIntentDrag(owner?: symbol): void {
  if (!inFlight || (owner !== undefined && inFlight.owner !== owner)) {
    return
  }
  inFlight = null
  if (typeof window !== 'undefined') {
    for (const type of TERMINAL_EVENTS) {
      window.removeEventListener(type, onTerminalEvent, true)
    }
  }
}

export function readLaunchIntentDrag(
  data: Pick<DataTransfer, 'getData' | 'types'>
): LaunchIntent | null {
  if (!data.types.includes(LAUNCH_INTENT_DRAG_TYPE)) {
    return null
  }
  try {
    const value: unknown = JSON.parse(data.getData(LAUNCH_INTENT_DRAG_TYPE))
    if (
      typeof value !== 'object' ||
      value === null ||
      !('agent' in value) ||
      !LAUNCHER_PROVIDERS.some((agent) => agent === value.agent)
    ) {
      return null
    }
    return { agent: value.agent as LauncherProvider }
  } catch {
    return null
  }
}
