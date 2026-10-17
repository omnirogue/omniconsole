/**
 * Every title the window sets on an existing session goes through the one organization change
 * path, carrying who chose the words (design: docs/reference/session-organization-change-path.md).
 * A tab `terminal create` names is recorded as the launch's; other creators (default tabs,
 * workflows) set a generated first title with its origin directly.
 */

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { conversationViewKey } from './conversation-view'
import { matchManagedSession } from './session-manage-sidebar-rows'
import { buildPaneSessions, type SidebarSession } from './sidebar-sessions'
import { undoOrganizationChangeWithNotice } from './session-organization-undo-notice'
import {
  applyOrganizationChange,
  applyPersonOrganizationChange,
  recordPersonOrganizationChange,
  type OrganizationChangeDeps,
  type OrganizationChangeOutcome
} from './session-organization-change'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import type {
  OrganizationExecutor,
  OrganizationTarget,
  OrganizationTitleOrigin
} from '../../../shared/session-organization-change'

type PersonSurface = Extract<OrganizationExecutor, { kind: 'person' }>['via']

/** A tab's session as a change target: the sidebar key its history is kept under, when listed. */
export function titleTargetForTab(tabId: string, paneKey?: string | null): OrganizationTarget {
  const session = matchManagedSession(buildPaneSessions(useAppStore.getState()), {
    tabId,
    ...(paneKey ? { paneKey } : {})
  })
  return {
    tabId,
    ...(session ? { sessionKey: conversationViewKey(session) } : {}),
    ...((paneKey ?? session?.paneKey) ? { paneKey: (paneKey ?? session?.paneKey)! } : {})
  }
}

/**
 * The person renaming a session (its sidebar row or its tab): applied before this returns and
 * recorded after, origin yours. A tab the change path cannot read still gets the name.
 */
export function renameSessionByPerson(
  input: { tabId: string; title: string | null; via: PersonSurface; target?: OrganizationTarget },
  deps: OrganizationChangeDeps = {}
): OrganizationChangeOutcome {
  const { outcome } = applyPersonOrganizationChange(
    {
      kind: 'title',
      targets: [input.target ?? titleTargetForTab(input.tabId)],
      value: input.title,
      origin: 'yours',
      executor: { kind: 'person', via: input.via }
    },
    deps
  )
  if (outcome.status !== 'applied') {
    // Why: a rename the person typed must never be lost to bookkeeping.
    useAppStore
      .getState()
      .setTabCustomTitle(input.tabId, input.title, { recordInteraction: true, origin: 'yours' })
  }
  return outcome
}

/** The sidebar row's pencil: the person's rename, kept under the row's own history key. */
export function renameSidebarSession(session: SidebarSession, title: string | null): void {
  if (session.tabId) {
    renameSessionByPerson({
      tabId: session.tabId,
      title,
      via: 'sidebar',
      target: {
        sessionKey: conversationViewKey(session),
        tabId: session.tabId,
        ...(session.paneKey ? { paneKey: session.paneKey } : {})
      }
    })
  }
}

/** Plain tab-strip signature, for the tab bars' `onSetCustomTitle`. */
export function renameTabByPerson(tabId: string, title: string | null): void {
  renameSessionByPerson({ tabId, title, via: 'pane-rename' })
}

/**
 * The pane header's rename: a split pane's own name, which its row shows when the tab has none.
 * The person's, recorded after. No before/after, so no Undo: that would write the tab's title.
 */
export function recordPaneRenameByPerson(
  input: { tabId: string; leafId: string; title: string | null },
  deps: OrganizationChangeDeps = {}
): void {
  const paneKey = isTerminalLeafId(input.leafId) ? makePaneKey(input.tabId, input.leafId) : null
  recordPersonOrganizationChange(
    {
      kind: 'title',
      targets: [titleTargetForTab(input.tabId, paneKey)],
      value: input.title,
      origin: 'yours',
      executor: { kind: 'person', via: 'pane-rename' }
    },
    {},
    deps
  )
}

/**
 * The first title `terminal create` gives a new tab: the launch's change, never the person's.
 * Recorded before it applies. Never rejects: whatever fails, the tab still gets its title,
 * unrecorded, so a launch never loses its title to bookkeeping.
 */
export async function titleNewTerminalTab(
  input: { tabId: string; title: string; origin: OrganizationTitleOrigin },
  deps: OrganizationChangeDeps = {}
): Promise<OrganizationChangeOutcome | null> {
  let outcome: OrganizationChangeOutcome | null = null
  try {
    outcome = await applyOrganizationChange(
      {
        kind: 'title',
        targets: [titleTargetForTab(input.tabId)],
        value: input.title,
        origin: input.origin,
        executor: { kind: 'launch', source: 'terminal-create' }
      },
      deps
    )
  } catch (error) {
    console.warn('[session-organization] recording a new tab title failed', error)
  }
  if (outcome?.status !== 'applied') {
    useAppStore.getState().setTabCustomTitle(input.tabId, input.title, {
      recordInteraction: false,
      origin: input.origin
    })
  }
  return outcome
}

export type TerminalRenameSource = 'terminal-rename' | 'session-launch'

/**
 * `omni terminal rename` and `omni session launch --title`: recorded before it applies, like
 * every change the person did not make here. Old CLIs send no origin, which reads as unknown.
 */
export async function renameTerminalRecorded(
  input: {
    tabId: string
    title: string | null
    origin?: OrganizationTitleOrigin
    source?: TerminalRenameSource
  },
  deps: OrganizationChangeDeps = {}
): Promise<OrganizationChangeOutcome> {
  const outcome = await applyOrganizationChange(
    {
      kind: 'title',
      targets: [titleTargetForTab(input.tabId)],
      value: input.title,
      origin: input.origin ?? 'unknown',
      executor:
        input.source === 'session-launch'
          ? { kind: 'launch', source: 'session-launch' }
          : { kind: 'cli' }
    },
    deps
  )
  if (outcome.status !== 'applied') {
    toast.error(
      translate('conversations.titles.renameRefused', 'A command could not rename a session'),
      { description: outcome.error }
    )
  }
  return outcome
}

export type GoalTitleRepair = { tabId: string; previous: string; next: string }

/**
 * #736's "Rename from their goals": the person's click is the permission, the app wrote the
 * words, so one person change with origin generated and one Undo from the recorded change.
 */
export function renameSessionsFromGoals(
  repairs: readonly GoalTitleRepair[],
  via: PersonSurface,
  deps: OrganizationChangeDeps = {}
): OrganizationChangeOutcome | null {
  if (repairs.length === 0) {
    return null
  }
  const values = repairs.map((repair) => repair.next)
  const { outcome } = applyPersonOrganizationChange(
    {
      kind: 'title',
      targets: repairs.map((repair) => titleTargetForTab(repair.tabId)),
      value: values[0],
      values,
      origin: 'generated',
      executor: { kind: 'person', via }
    },
    deps
  )
  if (outcome.status !== 'applied') {
    toast.error(outcome.error)
    return outcome
  }
  toast.success(
    repairs.length === 1
      ? translate('conversations.junkTitles.renamedOne', 'Renamed 1 session from its goal')
      : translate(
          'conversations.junkTitles.renamedMany',
          'Renamed {{count}} sessions from their goals',
          { count: repairs.length }
        ),
    {
      action: {
        label: translate('conversations.junkTitles.undo', 'Undo'),
        onClick: () => {
          void undoOrganizationChangeWithNotice(outcome.opId, via, deps)
        }
      }
    }
  )
  return outcome
}
