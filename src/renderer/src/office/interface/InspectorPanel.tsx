// @ts-nocheck
import { translate } from '@/i18n/i18n'
import React, { useEffect, useRef } from 'react'
import { getAllCharacters } from '../data/agents'
import { useChatAvailability } from '../integration/hooks/useChatAvailability'
import { useCoreStore } from '../integration/store/coreStore'
import { useActiveTeam } from '../integration/store/teamStore'
import { useUiStore } from '../integration/store/uiStore'
import { useSceneManager } from '../simulation/SceneContext'
import { Avatar } from './components/Avatar'
import AgentStatusPanel from './AgentStatusPanel'
import ChatPanel from './ChatPanel'
import ProjectView from './ProjectView'
import { InspectorPanelActions } from './InspectorPanelActions'

type InspectorPanelProps = {
  isFloating?: boolean
}

const InspectorPanel: React.FC<InspectorPanelProps> = ({ isFloating }) => {
  const { selectedNpcIndex, isChatting } = useUiStore()
  const scene = useSceneManager()
  const { phase, setFinalOutputOpen, tasks } = useCoreStore()
  const system = useActiveTeam()
  const agents = getAllCharacters(system)
  const { canChat, reason } = useChatAvailability(selectedNpcIndex)
  const prevCanChat = useRef(canChat)

  const agent =
    selectedNpcIndex !== null ? (agents.find((a) => a.index === selectedNpcIndex) ?? null) : null
  const isProjectReady = phase === 'done' && selectedNpcIndex === system.leadAgent.index

  const isLeadAgentIdle = selectedNpcIndex === system.leadAgent.index && phase === 'idle'
  const currentTask = tasks.find(
    (t) => t.assignedAgentId === selectedNpcIndex && t.status === 'in_progress'
  )
  const tasksOnHold = agent
    ? tasks.filter((t) => t.assignedAgentId === agent.index && t.status === 'on_hold')
    : []
  const hasTaskOnHold = tasksOnHold.length > 0

  const needsInput = isLeadAgentIdle || hasTaskOnHold

  // When canChat transitions true → false, end any active chat
  useEffect(() => {
    if (prevCanChat.current && !canChat) {
      if (isChatting) {
        useUiStore.getState().setChatting(false)
      }
    }
    prevCanChat.current = canChat
  }, [canChat, isChatting])

  const handleEndChat = () => {
    useUiStore.getState().setChatting(false)
  }

  const handleStartChat = () => {
    if (canChat && selectedNpcIndex !== null) {
      scene?.startChat(selectedNpcIndex)
    }
  }

  return (
    <div
      className={`${isFloating ? 'w-full h-full max-h-[85vh] self-end rounded-2xl shadow-2xl border border-white/20' : 'w-80 h-full border-l border-zinc-100'} bg-white flex flex-col pointer-events-auto shrink-0 relative z-30 overflow-hidden transition-all duration-300`}
    >
      {!agent ? (
        !isFloating && <ProjectView />
      ) : (
        <>
          {/* Header Section */}
          <div
            className={`px-4 py-3 border-b border-zinc-100 bg-white ${isFloating ? 'bg-zinc-50/50' : ''}`}
          >
            <div className="flex flex-col gap-4">
              {/* Agent Title Row */}
              <div className="flex items-center gap-4">
                <div className="shrink-0 rounded-2xl p-0.5 bg-zinc-50 border border-zinc-100/50">
                  <Avatar
                    type={
                      agent.index === system.user.index
                        ? 'user'
                        : agent.index === system.leadAgent.index
                          ? 'lead'
                          : 'sub'
                    }
                    color={agent.color}
                    size={48}
                  />
                </div>
                <div className="flex flex-col min-w-0">
                  <h2 className="text-xl font-black text-darkDelegation leading-tight truncate">
                    {agent.name}
                  </h2>
                  {agent.index !== system.user.index && (
                    <div className="flex mt-1">
                      {agent.index === system.leadAgent.index ? (
                        <div
                          className="text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-tighter border shadow-sm leading-none flex items-center h-4 shrink-0"
                          style={{
                            backgroundColor: `${agent.color}15`,
                            color: agent.color,
                            borderColor: `${agent.color}30`
                          }}
                        >
                          {translate('office.panels.inspectorPanel.leadAgent', 'Lead Agent')}
                        </div>
                      ) : (
                        <div
                          className="text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-tighter border shadow-sm leading-none flex items-center h-4 shrink-0"
                          style={{
                            backgroundColor: `${agent.color}15`,
                            color: agent.color,
                            borderColor: `${agent.color}30`
                          }}
                        >
                          {translate('office.panels.inspectorPanel.subagent', 'Subagent')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <InspectorPanelActions
                agent={agent}
                system={system}
                isChatting={isChatting}
                isProjectReady={isProjectReady}
                needsInput={needsInput}
                isLeadAgentIdle={isLeadAgentIdle}
                tasksOnHold={tasksOnHold}
                canChat={canChat}
                reason={reason}
                handleStartChat={handleStartChat}
                setFinalOutputOpen={setFinalOutputOpen}
              />
            </div>
          </div>

          <div
            className={`flex-1 overflow-y-auto scrollbar-sleek relative min-h-0 ${isFloating ? 'bg-white' : 'bg-zinc-50/30'}`}
          >
            {isChatting ? (
              <div className="flex flex-col h-full bg-white">
                <div className="flex-1 overflow-y-auto scrollbar-sleek">
                  <ChatPanel />
                </div>
                {/* Close Chat button at the bottom when chatting */}
                <div className="p-3 bg-white border-t border-zinc-100 shrink-0">
                  <button
                    onClick={handleEndChat}
                    className="w-full h-10 px-4 bg-darkDelegation hover:bg-black text-white rounded-xl flex items-center justify-center gap-2 transition-all active:scale-95 text-[10px] font-black uppercase tracking-widest shadow-md"
                  >
                    <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                    {translate('office.panels.inspectorPanel.closeChat', 'Close Chat')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col h-full">
                <div className="flex-1">
                  <AgentStatusPanel agentIndex={selectedNpcIndex!} />
                </div>
                {/* Fleet task ids are `sess:<session_id>` — link straight to the
                    session detail, where the shared Durable Revive action lives
                    for canonical hub (ses_*) sessions. No second revive client
                    in the simulation layer, per the SESSION-REVIVE spec. */}
                {currentTask?.id.startsWith('sess:') && (
                  <a
                    href={`/sessions/${encodeURIComponent(currentTask.id.slice(5))}`}
                    data-testid="inspector-session-link"
                    className="mt-2 w-full h-9 px-4 bg-darkDelegation hover:bg-black text-white rounded-xl flex items-center justify-center gap-2 transition-all text-[10px] font-black uppercase tracking-widest shadow-md"
                  >
                    {currentTask.id.slice(5).startsWith('ses_')
                      ? translate(
                          'office.panels.inspectorPanel.sessionDetailDurableRevive',
                          'Session Detail · Durable Revive'
                        )
                      : translate('office.panels.inspectorPanel.sessionDetail', 'Session Detail')}
                  </a>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default InspectorPanel
