import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useSessionOutputs } from '@/components/next-action/use-session-outputs'
import { usePendingNextStepCount } from '@/components/next-steps/next-steps-pending-store'
import { useSessionChainForRow } from '@/lib/session-chain-registry'
import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import { sessionFileContext } from '@/lib/session-files-and-links-actions'
import type { ConversationSource } from '../../../../../shared/conversation-source'
import { SessionDocumentTab } from './SessionDocumentTab'
import { SessionFilesTab, type SessionPanelFile } from './SessionFilesTab'
import { SessionDeliverables } from './SessionDeliverables'
import { SessionNextSteps } from './SessionNextSteps'
import { SessionWorkLog } from './SessionWorkLog'
import type { SessionPanelItem } from './session-panel-items'
import { useSessionPanelTranscript } from './session-panel-transcript'
import {
  takeSessionPanelViewRequest,
  useSessionPanelViewRequest
} from './session-panel-view-request'
import {
  availableSessionWorkTabs,
  resolveSessionWorkTab,
  sessionWorkTabLabel,
  type SessionWorkTab
} from './session-work-tabs'
import { useOnScreenSidebarSession } from './use-on-screen-sidebar-session'
import { sessionWaitsModel } from './session-waits-model'
import { useSessionWorkLogAvailable } from './use-session-work-log-available'
import { useSessionWrittenFiles } from './use-session-written-files'

type TabChoice = { tab: SessionWorkTab | null; revision: number; requested: boolean }

function tabForItem(item: SessionPanelItem | undefined): SessionWorkTab | null {
  return item
    ? item.kind === 'artifact'
      ? 'omnios'
      : item.kind === 'slite'
        ? 'plan'
        : 'files'
    : null
}

/**
 * The right panel's Session work for the conversation on screen: its omnios pages, its Slite
 * plan, the files it created and its work log, as tabs in one fixed order. A tab exists only while
 * it has something real; content never comes from another session (the panel remounts per session).
 */
export function SessionArtifactPanel({
  artifacts,
  onScreen = true,
  visible,
  pickedKey,
  onPick,
  selectionRevision
}: {
  artifacts: readonly SessionPanelItem[]
  /** False while no conversation is on screen (an editor tab, say): nothing to show yet. */
  onScreen?: boolean
  visible: boolean
  pickedKey: string | null
  onPick: (key: string) => void
  selectionRevision: number
}): React.JSX.Element {
  const session = useOnScreenSidebarSession()
  const messages = useSessionPanelTranscript(session ? (session.paneKey ?? session.tabId) : null)
  const hookFiles = useSessionWrittenFiles(session, visible)
  const outputs = useSessionOutputs({
    worktreeId: session?.worktreeId ?? '',
    hostId: session?.hostId ?? null,
    messages,
    active: visible && session !== null,
    reviewOnlyWhenLinked: true,
    hookFiles
  })
  const address = session ? conversationSourceForSession(session) : null
  const addressKey = address ? JSON.stringify(address) : null
  const conversation = useMemo(
    () => (addressKey ? (JSON.parse(addressKey) as ConversationSource) : null),
    [addressKey]
  )
  // Why waits too: the Next steps view also lists what the session waits on (#696).
  const waits = sessionWaitsModel(useSessionChainForRow(session?.rowKey ?? null))?.waits.length ?? 0
  const nextSteps = (usePendingNextStepCount(conversation) ?? 0) + waits
  const workLog = useSessionWorkLogAvailable(session, messages)

  const pages = artifacts.filter(
    (item): item is Extract<SessionPanelItem, { kind: 'artifact' }> => item.kind === 'artifact'
  )
  const plans = artifacts.filter(
    (item): item is Extract<SessionPanelItem, { kind: 'slite' }> => item.kind === 'slite'
  )
  const files = useMemo(() => {
    const byKey = new Map<string, SessionPanelFile>()
    for (const item of artifacts) {
      if (item.kind === 'file') {
        const parts = item.path.split(/[\\/]/).filter(Boolean)
        byKey.set(item.key, { ...item, name: parts.at(-1) ?? item.path, location: '' })
      }
    }
    for (const card of outputs.cards) {
      if (card.type === 'file' && outputs.target && !byKey.has(`file:${card.path}`)) {
        byKey.set(`file:${card.path}`, {
          kind: 'file',
          key: `file:${card.path}`,
          at: card.messageIndex,
          path: card.path,
          context: sessionFileContext(outputs.target, card.path),
          name: card.name,
          location: card.location
        })
      }
    }
    return [...byKey.values()]
  }, [artifacts, outputs.cards, outputs.target])
  // Why: a page or plan already has its own tab; listing its link again under Files repeats it.
  const docUrls = new Set(
    artifacts.flatMap((item) =>
      item.kind === 'artifact'
        ? [item.record.shareUrl.replace(/\/$/, '')]
        : item.kind === 'slite'
          ? [item.url.replace(/\/$/, '')]
          : []
    )
  )
  const links = outputs.cards.filter(
    (card) =>
      card.type !== 'file' && !(card.type === 'link' && docUrls.has(card.url.replace(/\/$/, '')))
  )

  // Why revision -1: a panel mounted by a link click opens on that link's tab, not the first one.
  const [choice, setChoice] = useState<TabChoice>({ tab: null, revision: -1, requested: false })
  // "Open in panel" and the collapsed indicator land here, once.
  const requestedView = useSessionPanelViewRequest((s) => s.view)
  useEffect(() => {
    const taken = requestedView ? takeSessionPanelViewRequest() : null
    if (taken) {
      setChoice({ tab: taken, revision: selectionRevision, requested: true })
    }
  }, [requestedView, selectionRevision])
  // Why: a link clicked in the conversation picks its document; show the tab that holds it.
  const linkTab = tabForItem(artifacts.find((item) => item.key === pickedKey))
  const current = choice.revision === selectionRevision ? choice : null
  const available = availableSessionWorkTabs(
    {
      pages: pages.length,
      plans: plans.length,
      files: files.length + links.length,
      workLog,
      nextSteps
    },
    current?.requested ? current.tab : null
  )
  const tab = resolveSessionWorkTab(available, current ? current.tab : (linkTab ?? choice.tab))

  if (tab === null) {
    return (
      <p className="p-3 text-xs text-muted-foreground" data-session-work-empty="">
        {onScreen
          ? translate('sessionPanel.nothingYet', 'Nothing from this session yet.')
          : translate('sessionPanel.noSession', 'Open a conversation to see its work here.')}
      </p>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-session-work-tab={tab}>
      <div
        className="flex flex-wrap gap-0.5 border-b px-2 py-1.5"
        role="group"
        aria-label={translate('sessionPanel.views', 'Session work views')}
      >
        {available.map((option) => (
          <Button
            key={option}
            size="xs"
            // Why px-1.5: all five tabs fit one row at the panel's default 350px width.
            className="px-1.5"
            variant={tab === option ? 'secondary' : 'ghost'}
            aria-pressed={tab === option}
            onClick={() =>
              setChoice({ tab: option, revision: selectionRevision, requested: false })
            }
          >
            {sessionWorkTabLabel(option)}
          </Button>
        ))}
      </div>
      {tab === 'omnios' || tab === 'plan' ? (
        <SessionDocumentTab
          items={tab === 'omnios' ? pages : plans}
          visible={visible}
          pickedKey={pickedKey}
          onPick={onPick}
        />
      ) : null}
      {tab === 'files' ? (
        <SessionFilesTab
          files={files}
          links={links}
          outputs={outputs}
          worktreeId={session?.worktreeId ?? ''}
          hostId={session?.hostId ?? null}
          visible={visible}
          pickedKey={pickedKey}
          selectionRevision={selectionRevision}
          deliverables={<SessionDeliverables session={session} active={visible} />}
        />
      ) : null}
      {tab === 'work-log' && session ? (
        <SessionWorkLog session={session} messages={messages} />
      ) : null}
      {tab === 'next-steps' && session ? (
        <SessionNextSteps key={session.rowKey} session={session} visible={visible} />
      ) : null}
    </div>
  )
}
