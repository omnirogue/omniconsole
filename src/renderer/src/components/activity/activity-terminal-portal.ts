import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'
import type { TopLevelView } from '../../../../shared/ui-chrome-types'

export type ActivityTerminalPortalTarget = {
  slotId: string
  requestToken: string
  target: HTMLElement
  worktreeId: string
  tabId: string
  // Why: each Activity thread targets one stable terminal leaf inside a tab.
  // Carry the durable paneKey across this boundary; TerminalPane resolves it
  // to the current numeric PaneManager handle immediately before isolation.
  paneKey: string
  forceUnavailable?: boolean
  active: boolean
  mounted?: boolean
  visible?: boolean
  focused?: boolean
  passiveViewer?: boolean
}

let currentTargets: ActivityTerminalPortalTarget[] = []
const targetsByOwner = new Map<string, ActivityTerminalPortalTarget[]>()
let ownedTargets: ActivityTerminalPortalTarget[] = []
const emptyTargets: ActivityTerminalPortalTarget[] = []
const subscribers = new Set<() => void>()

type ActivityTerminalPortalFieldEquals = (
  left: ActivityTerminalPortalTarget,
  right: ActivityTerminalPortalTarget
) => boolean

// Why the keyed record: a dropped field here silently suppresses a publish and
// strands Terminal on stale routing — the wrong-terminal flash this file exists
// to prevent. `satisfies` turns a new descriptor field into a build error.
const ACTIVITY_TERMINAL_PORTAL_FIELD_EQUALS: readonly ActivityTerminalPortalFieldEquals[] =
  Object.values({
    slotId: (left, right) => left.slotId === right.slotId,
    requestToken: (left, right) => left.requestToken === right.requestToken,
    target: (left, right) => left.target === right.target,
    worktreeId: (left, right) => left.worktreeId === right.worktreeId,
    tabId: (left, right) => left.tabId === right.tabId,
    paneKey: (left, right) => left.paneKey === right.paneKey,
    forceUnavailable: (left, right) => left.forceUnavailable === right.forceUnavailable,
    active: (left, right) => left.active === right.active,
    mounted: (left, right) => left.mounted === right.mounted,
    visible: (left, right) => left.visible === right.visible,
    focused: (left, right) => left.focused === right.focused,
    passiveViewer: (left, right) => left.passiveViewer === right.passiveViewer
  } satisfies Record<keyof ActivityTerminalPortalTarget, ActivityTerminalPortalFieldEquals>)

function haveSameActivityTerminalPortals(
  left: readonly ActivityTerminalPortalTarget[],
  right: readonly ActivityTerminalPortalTarget[]
): boolean {
  return (
    left.length === right.length &&
    left.every((target, index) => {
      const candidate = right[index]
      return (
        candidate !== undefined &&
        ACTIVITY_TERMINAL_PORTAL_FIELD_EQUALS.every((isEqual) => isEqual(target, candidate))
      )
    })
  )
}

// Why: the portal target is published with its {worktreeId, tabId} already
// attached so consumers don't have to derive routing from the global
// activeTabId/activeWorktreeId. The activity page knows which agent pane it
// wants to display; deriving from global active state introduced a race where
// repo/worktree updates landed before the matching setActiveTab, briefly
// portaling a different terminal into the activity slot ("flash" of the wrong
// terminal for a few ms).
export function setActivityTerminalPortals(
  targets: ActivityTerminalPortalTarget[],
  owner = 'legacy'
): void {
  const previous = targetsByOwner.get(owner) ?? emptyTargets
  const ownerChanged = !haveSameActivityTerminalPortals(previous, targets)
  const legacyChanged = !haveSameActivityTerminalPortals(currentTargets, targets)
  if (!ownerChanged && !legacyChanged) {
    return
  }
  if (ownerChanged) {
    if (targets.length === 0) {
      targetsByOwner.delete(owner)
    } else {
      targetsByOwner.set(owner, targets)
    }
    ownedTargets = [...targetsByOwner.values()].flat()
  }
  // Why: the setting-off snapshot retains the original last-writer/clear-all contract.
  currentTargets = targets
  for (const subscriber of subscribers) {
    subscriber()
  }
}

export function isActivityTerminalPortalVisible(
  portal: ActivityTerminalPortalTarget | null
): boolean {
  return portal !== null && portal.mounted !== false && portal.visible !== false
}

function subscribeActivityTerminalPortals(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange)
  return () => {
    subscribers.delete(onStoreChange)
  }
}

// Why these views: each is a full page over the hidden workbench, so a page there can borrow a
// live terminal (Activity, Attention, the Grid, the Build + Review and Local runs live panes, and a
// project's chat on its page). In the workspace view the terminal is on screen in its own tab, and
// a portal would pull it out.
const TERMINAL_PORTAL_VIEWS: ReadonlySet<TopLevelView> = new Set<TopLevelView>([
  'activity',
  'attention',
  'buildReview',
  'localRuns',
  'grid',
  'project'
])

/** Whether Terminal should honour portal requests while `view` is showing. */
export function viewHostsTerminalPortals(view: TopLevelView): boolean {
  return TERMINAL_PORTAL_VIEWS.has(view)
}

export function useActivityTerminalPortals(
  enabled: boolean,
  commandCenter = false
): ActivityTerminalPortalTarget[] {
  const windowVisible = useSyncExternalStore(
    commandCenter ? subscribeWindowParkVisibility : () => () => {},
    commandCenter ? getWindowParkVisible : () => true,
    () => true
  )
  // Why: portal targets live in module state so Terminal can consume them
  // without routing through the app store; subscribe as an external store.
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      enabled ? subscribeActivityTerminalPortals(onStoreChange) : () => {},
    [enabled]
  )

  const getSnapshot = useCallback(
    () => (enabled ? (commandCenter ? ownedTargets : currentTargets) : emptyTargets),
    [enabled, commandCenter]
  )
  const targets = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return useMemo(
    () =>
      targets.map((portal) => {
        const visible = commandCenter
          ? portal.mounted !== false && portal.visible !== false && windowVisible
          : true
        return {
          ...portal,
          mounted: commandCenter ? portal.mounted !== false : true,
          visible,
          focused: commandCenter ? visible && (portal.focused ?? portal.active) : portal.active,
          active: commandCenter ? visible && (portal.focused ?? portal.active) : portal.active
        }
      }),
    [commandCenter, targets, windowVisible]
  )
}

export function findActivityTerminalPortal(
  targets: ActivityTerminalPortalTarget[],
  query: {
    worktreeId: string
    tabId: string
    slotId?: string
    paneKey?: string
    requestToken?: string
  }
): ActivityTerminalPortalTarget | null {
  const matchingTab = targets.filter(
    (target) =>
      target.mounted !== false &&
      target.worktreeId === query.worktreeId &&
      target.tabId === query.tabId
  )
  if (
    query.slotId !== undefined ||
    query.paneKey !== undefined ||
    query.requestToken !== undefined
  ) {
    const exact = matchingTab.find(
      (target) =>
        (query.slotId === undefined || target.slotId === query.slotId) &&
        (query.paneKey === undefined || target.paneKey === query.paneKey) &&
        (query.requestToken === undefined || target.requestToken === query.requestToken)
    )
    if (exact) {
      return exact
    }
  }
  return (
    matchingTab.find((target) => target.active && isActivityTerminalPortalVisible(target)) ??
    (matchingTab.length === 1 ? matchingTab[0] : null) ??
    null
  )
}
