import { translate } from '@/i18n/i18n'
import { SessionContextEditor } from '@/components/session-context/SessionContextEditor'
import { sessionContextKey } from '@/lib/session-context-store'
import { useId, useRef, useState, type ReactNode } from 'react'
import { UpNextSubject } from '@/components/next-action/UpNextSubject'
import { UpNextVisibilityContext } from '@/components/next-action/up-next-visibility'
import { SessionDetailsConnected } from '@/components/next-action/advanced/SessionDetailsConnected'
import { SessionFilesAndLinksView } from '@/components/next-action/SessionFilesAndLinks'
import { useSessionOutputs } from '@/components/next-action/use-session-outputs'
import { useSessionDetailsFacts } from '@/components/next-action/use-session-details-facts'
import { SessionActivityPanel } from '@/components/session-activity/SessionActivityPanel'
import { SessionGoalTodosDetails } from '@/components/goals-todos/SessionGoalTodosDetails'
import { goalHeadline } from '@/components/goals-todos/SessionProgress'
import { useSessionGoalGroups } from '@/components/goals-todos/use-session-goal-groups'
import { useSessionMissionProgress } from '@/components/goals-todos/use-session-mission-progress'
import { SessionMissionCard } from '@/components/goals-todos/SessionMissionCard'
import { useSessionGoalTodos } from '@/components/goals-todos/use-session-goal-todos'
import { ConversationContextDetails } from '@/components/session-activity/ConversationContextDetails'
import { useSessionChainForRow } from '@/lib/session-chain-registry'
import { sidebarSessionStatusKey } from '@/lib/sidebar-session-source-identity'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { WorkHeaderStrip } from './WorkHeaderStrip'
import { escapeFoldsPanel, useWorkHeaderCollapse } from './use-work-header-collapse'
import { workHeaderSummary } from './work-header-summary'
import { useShareSessionPanelTranscript } from '@/components/right-sidebar/session-artifact/session-panel-transcript'

export type ConversationInformationSection = 'details' | 'outcome'

/** Keep visited panels mounted so switching disclosures retains unsaved form input. */
function InformationPanel({
  open,
  children,
  ...props
}: {
  open: boolean
  children: ReactNode
  id: string
  label: string
  panelRef?: React.Ref<HTMLDivElement>
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>
  section: ConversationInformationSection
}) {
  const [visited, setVisited] = useState(open)
  if (open && !visited) {
    setVisited(true)
  }
  return (
    <div
      id={props.id}
      ref={props.panelRef}
      hidden={!open}
      role="region"
      aria-label={props.label}
      data-conversation-information-panel={props.section}
      data-work-header-panel={props.section === 'outcome' ? '' : undefined}
      className="max-h-[45vh] min-w-0 overflow-y-auto border-t p-3 text-xs scrollbar-sleek"
      onKeyDown={props.onKeyDown}
    >
      {visited ? children : null}
    </div>
  )
}

export function ConversationInformation({
  session,
  trailing,
  messages,
  showOutcome
}: {
  session: SidebarSession
  trailing: ReactNode
  messages?: readonly NativeChatMessage[]
  showOutcome: boolean
}) {
  useShareSessionPanelTranscript(session.paneKey ?? session.tabId, messages)
  const chain = useSessionChainForRow(session.rowKey)
  const facts = useSessionDetailsFacts(session, chain)
  // Why the status key: a structured chat's row has no pane; its status lives under its own key.
  const statusKey = sidebarSessionStatusKey(session)
  const paneAgentState = useAppStore((state) =>
    statusKey ? state.agentStatusByPaneKey[statusKey]?.state : undefined
  )
  const paneWorkingMode = useAppStore((state) =>
    statusKey ? state.agentStatusByPaneKey[statusKey]?.workingMode : undefined
  )
  const paneBackgroundTaskCount = useAppStore((state) =>
    statusKey ? state.agentStatusByPaneKey[statusKey]?.backgroundTaskCount : undefined
  )
  const panelRef = useRef<HTMLDivElement>(null)
  const outcomeRef = useRef<HTMLButtonElement>(null)
  const detailsRef = useRef<HTMLButtonElement>(null)
  const detailsId = useId()
  const fold = useWorkHeaderCollapse({
    session,
    chain,
    paneAgentState,
    panelRef,
    chevronRef: outcomeRef
  })
  const [otherSection, setOtherSection] = useState<'details' | null>(null)
  const outcomeOpen = !fold.collapsed
  const section = outcomeOpen ? 'outcome' : otherSection
  // A new needs-you transition can open Outcome; closing it should return to the conversation.
  if (outcomeOpen && otherSection !== null) {
    setOtherSection(null)
  }
  const toggle = (next: ConversationInformationSection) => {
    if (next === 'outcome') {
      setOtherSection(null)
      fold.toggle()
    } else {
      if (!fold.collapsed) {
        fold.setCollapsed(true)
      }
      setOtherSection(section === next ? null : next)
    }
  }
  const closeOther: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (!escapeFoldsPanel(event, event.currentTarget)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    setOtherSection(null)
    detailsRef.current?.focus()
  }
  // Why two modes: the header needs PR state once; an open info card keeps it fresh.
  const goalView = useSessionGoalTodos(session, messages, section === 'details')
  const goals = useSessionGoalGroups(
    messages,
    section === 'details' ? 'poll' : 'once',
    goalView.pullRequests
  )
  const mission = useSessionMissionProgress(session, goalView, chain, goals)
  // Why built here: the to-do list and Files & links show the same outputs; check files once.
  // Only an open info card reads the transcript for them, so a closed one costs nothing.
  const outputs = useSessionOutputs({
    worktreeId: session.worktreeId,
    hostId: session.hostId,
    messages: section === 'details' ? messages : undefined,
    active: section === 'details'
  })
  const currentGoal = goals.at(-1)
  const summary = workHeaderSummary({
    chain,
    session,
    agentState: facts.agent.state,
    paneAgentState,
    paneWorkingMode,
    paneBackgroundTaskCount,
    progress: mission
      ? `${mission.mission.title} · ${mission.verified}/${mission.items.length} ${translate('missionProgress.verified', 'Verified')}${mission.current ? ` · ${mission.current.title}` : ''}`
      : currentGoal
        ? goalHeadline(currentGoal).text
        : null
  })
  return (
    <>
      <WorkHeaderStrip
        session={session}
        collapsed={!outcomeOpen}
        panelId={fold.panelId}
        summary={summary}
        onToggle={() => toggle('outcome')}
        chevronRef={outcomeRef}
        trailing={trailing}
        section={section}
        onSectionToggle={toggle}
        detailsId={detailsId}
        detailsRef={detailsRef}
        showOutcome={showOutcome}
      />
      <InformationPanel
        section="details"
        id={detailsId}
        label={translate('nextAction.sessionDetails', 'Session details')}
        open={section === 'details'}
        onKeyDown={closeOther}
      >
        <div className="max-w-md rounded-xl border bg-card p-3">
          {mission ? (
            <SessionMissionCard
              progress={mission}
              screenshots={
                outputs.cards.filter((card) => card.type === 'file' && card.kind === 'image').length
              }
              evidence={
                <SessionFilesAndLinksView
                  outputs={outputs}
                  hostId={session.hostId}
                  worktreeId={session.worktreeId}
                />
              }
              metadata={
                <SessionDetailsConnected
                  facts={facts}
                  chain={chain}
                  sections={{ more: <ConversationContextDetails messages={messages} /> }}
                />
              }
            />
          ) : (
            <SessionDetailsConnected
              facts={facts}
              chain={chain}
              onOpenOutcome={() => {
                setOtherSection(null)
                fold.setCollapsed(false)
              }}
              sections={{
                goalAndTodos: (
                  <SessionGoalTodosDetails
                    session={session}
                    messages={messages}
                    active={section === 'details'}
                    goals={goals}
                    outputs={outputs}
                  />
                ),
                // Why no list here: the To-do section above already shows it in full.
                activity: (
                  <SessionActivityPanel
                    session={session}
                    messages={messages}
                    showTodoList={false}
                  />
                ),
                filesAndLinks: (
                  <SessionFilesAndLinksView
                    outputs={outputs}
                    hostId={session.hostId}
                    worktreeId={session.worktreeId}
                  />
                ),
                more: <ConversationContextDetails messages={messages} />
              }}
            />
          )}
        </div>
      </InformationPanel>

      <InformationPanel
        section="outcome"
        id={fold.panelId}
        label={translate('sessionContext.contextAndOutcome', 'Session context & outcome')}
        open={outcomeOpen}
        panelRef={panelRef}
        onKeyDown={fold.onPanelKeyDown}
      >
        <div className="space-y-4">
          <SessionContextEditor
            key={sessionContextKey(session)}
            contextKey={sessionContextKey(session)}
            worktreeId={session.worktreeId}
            session={session}
          />
          {showOutcome && (
            <UpNextVisibilityContext value={outcomeOpen}>
              <UpNextSubject subject={{ kind: 'session', session }} compactAdd />
            </UpNextVisibilityContext>
          )}
        </div>
      </InformationPanel>
    </>
  )
}
