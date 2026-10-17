import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { SessionConversationTitleSource } from '../../../shared/session-conversation-ledger'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { isPlaceholderConversationTitle, readableConversationLabel } from './conversation-state'

/**
 * Where a sidebar row's label came from (session parity, addendum F2): the person's rename
 * (`custom`), the pane's or terminal's own title (`terminal`), a title the app or the agent wrote
 * (`generated`), or no title at all (`agent`): the agent's name — or a record's prompt, which this
 * computer may show but a paired computer never receives (it gets the agent's name and shows its
 * own "<agent> (untitled)").
 */
export type SidebarSessionLabelSource = SessionConversationTitleSource

export type SidebarSessionLabel = { label: string; labelSource: SidebarSessionLabelSource }

type LabelCandidate = readonly [value: string | null | undefined, source: SidebarSessionLabelSource]

/** `a || b || … || last` with the source of the value it picked (the last one even when empty). */
export function firstSessionLabel(candidates: readonly LabelCandidate[]): SidebarSessionLabel {
  const picked = candidates.find(([value]) => Boolean(value)) ?? candidates.at(-1)
  return { label: picked?.[0] ?? '', labelSource: picked?.[1] ?? 'agent' }
}

/** `readableConversationLabel(a || b || …)`: a placeholder ("Terminal 3", blank) names the agent. */
function readableSessionLabel(
  candidates: readonly LabelCandidate[],
  agent: string
): SidebarSessionLabel {
  const picked = firstSessionLabel(candidates)
  return isPlaceholderConversationTitle(picked.label)
    ? { label: readableConversationLabel(picked.label, agent), labelSource: 'agent' }
    : picked
}

/**
 * A terminal pane row's label in the sidebar's order: the rename, the paired owner's or the pane's
 * own title, the generated or agent title, then the terminal titles. A pane no agent reports is
 * named by its saved outcome after the rename.
 */
export function terminalPaneSessionLabel(args: {
  tab: Pick<
    TerminalTab,
    'customTitle' | 'runtimeOwnerTitleByLeafId' | 'generatedTitle' | 'aiVaultTitle' | 'title'
  >
  layout: Pick<TerminalLayoutSnapshot, 'titlesByLeafId'> | undefined
  /** '' for a tab whose pane has no leaf yet: it has no pane title. */
  paneKey: string
  agent: string
  entryTitle: string | undefined
  recordTitle: string | undefined
  outcome: string | undefined
}): SidebarSessionLabel {
  const { tab, agent } = args
  if (args.outcome) {
    return readableSessionLabel(
      [
        [tab.customTitle, 'custom'],
        [args.outcome, 'generated']
      ],
      agent
    )
  }
  const leafId = args.paneKey ? (parsePaneKey(args.paneKey)?.leafId ?? '') : null
  return readableSessionLabel(
    [
      [tab.customTitle, 'custom'],
      // Why: a paired owner's name for the pane, ahead of the terminal's own title.
      [leafId === null ? undefined : tab.runtimeOwnerTitleByLeafId?.[leafId], 'terminal'],
      [leafId === null ? undefined : args.layout?.titlesByLeafId?.[leafId], 'terminal'],
      [tab.generatedTitle, 'generated'],
      // Why: a pasted first prompt leaves no generated title; the agent's own names it.
      [tab.aiVaultTitle?.title.trim(), 'generated'],
      [args.entryTitle, 'terminal'],
      [args.recordTitle, 'terminal'],
      [tab.title, 'terminal']
    ],
    agent
  )
}

/** A tab-less record row: its terminal title, else its prompt or agent — never a title to share. */
export function sleepingRecordSessionLabel(
  record: Pick<SleepingAgentSessionRecord, 'terminalTitle' | 'prompt' | 'agent'>
): SidebarSessionLabel {
  return firstSessionLabel([
    [record.terminalTitle, 'terminal'],
    [record.prompt, 'agent'],
    [record.agent, 'agent']
  ])
}
