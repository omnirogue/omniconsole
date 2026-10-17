import { translate } from '@/i18n/i18n'
import { FolderOpen, GitPullRequest, Lock, MessageSquare, MessageSquareWarning } from 'lucide-react'
import type { AgenticSystem, AgentNode } from '../data/agents'
import type { Task } from '../integration/store/coreStore'
import { useUiStore } from '../integration/store/uiStore'
import { USER_COLOR, USER_COLOR_LIGHT, USER_COLOR_SOFT } from '../theme/brand'
import { ReferenceImages } from './components/ReferenceImages'

type InspectorPanelActionsProps = {
  agent: AgentNode
  system: AgenticSystem
  isChatting: boolean
  isProjectReady: boolean
  needsInput: boolean
  isLeadAgentIdle: boolean
  tasksOnHold: Task[]
  canChat: boolean
  reason: string
  handleStartChat: () => void
  setFinalOutputOpen: (open: boolean) => void
}

export function InspectorPanelActions({
  agent,
  system,
  isChatting,
  isProjectReady,
  needsInput,
  isLeadAgentIdle,
  tasksOnHold,
  canChat,
  reason,
  handleStartChat,
  setFinalOutputOpen
}: InspectorPanelActionsProps) {
  return (
    <>
      {/* Conditional Discussion/Chat Actions */}
      {needsInput && isChatting && (
        <div
          className="border rounded-xl p-3 shadow-sm animate-in fade-in slide-in-from-top-1"
          style={{ backgroundColor: USER_COLOR_LIGHT, borderColor: USER_COLOR_SOFT }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div
                className="flex items-center justify-center w-4 h-4 rounded text-white shadow-sm"
                style={{ backgroundColor: USER_COLOR }}
              >
                <MessageSquareWarning size={10} strokeWidth={3} />
              </div>
              <span
                className="text-[9px] font-black uppercase tracking-widest"
                style={{ color: USER_COLOR }}
              >
                {translate('office.panels.inspectorPanel.reviewRequested', 'Review Requested')}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600">
                {translate('office.panels.inspectorPanel.active', 'Active')}
              </span>
            </div>
          </div>
          <p className="text-[12px] font-bold text-darkDelegation leading-tight mt-1.5">
            {isLeadAgentIdle
              ? translate(
                  'office.panels.inspectorPanel.waitingForBriefReview',
                  'Waiting to review user brief.'
                )
              : translate(
                  'office.panels.inspectorPanel.agentNeedsInput',
                  '{{agentName}} needs input.',
                  { agentName: agent?.name }
                )}
          </p>
        </div>
      )}

      {needsInput && !isChatting ? (
        <div className="flex flex-col gap-3 p-4 bg-zinc-50 border border-zinc-100 rounded-xl animate-in fade-in slide-in-from-top-1 shadow-sm">
          <div className="flex items-center gap-1.5 font-black uppercase tracking-widest text-[9px]">
            <div
              className="flex items-center justify-center w-5 h-5 border rounded-lg"
              style={{
                backgroundColor: USER_COLOR_LIGHT,
                borderColor: USER_COLOR_SOFT,
                color: USER_COLOR
              }}
            >
              <MessageSquareWarning size={12} strokeWidth={3} />
            </div>
            <span style={{ color: USER_COLOR }}>
              {translate('office.panels.inspectorPanel.reviewRequested', 'Review Requested')}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-[12px] font-bold text-darkDelegation leading-tight">
              {isLeadAgentIdle
                ? translate(
                    'office.panels.inspectorPanel.reviewBriefWithTeam',
                    'Review the user brief with the team.'
                  )
                : translate(
                    'office.panels.inspectorPanel.taskSubmittedForReview',
                    'I\'ve finished the task "{{taskTitle}}". I\'ve submitted my work for your review.',
                    {
                      taskTitle:
                        tasksOnHold[0]?.title ??
                        translate('office.panels.inspectorPanel.work', 'Work')
                    }
                  )}
            </p>

            {isLeadAgentIdle &&
              (system.outputType === 'image' || system.outputType === 'video') && (
                <div className="mt-1 pt-3 border-t border-zinc-200/50">
                  <ReferenceImages />
                </div>
              )}

            <button
              onClick={
                isLeadAgentIdle
                  ? handleStartChat
                  : () => {
                      const task = tasksOnHold[0]
                      if (task) {
                        useUiStore.getState().setActiveAuditTaskId(task.id)
                      }
                    }
              }
              disabled={isLeadAgentIdle ? !canChat : false}
              className="flex items-center justify-center gap-2 bg-darkDelegation hover:bg-black active:scale-95 disabled:opacity-50 text-white px-4 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shadow-sm mt-1"
            >
              {isLeadAgentIdle ? (
                <>
                  <MessageSquare size={14} strokeWidth={3} />
                  {translate('office.panels.inspectorPanel.chatAboutBrief', 'Chat about the brief')}
                </>
              ) : (
                <>
                  <GitPullRequest size={14} strokeWidth={3} />
                  {translate('office.panels.inspectorPanel.reviewTask', 'Review Task')}
                </>
              )}
            </button>
          </div>
        </div>
      ) : (
        /* Chat Action Button below name - ONLY SHOW IF NOT NEEDS DISCUSSION (OR IF CHATTING) */
        <div className="w-full">
          {agent.index === system.user.index ? null : isProjectReady ? ( // No chat button for the local player
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 flex flex-col gap-3 shadow-sm">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                <span className="text-[10px] font-black uppercase tracking-widest text-yellow-700">
                  {translate('office.panels.inspectorPanel.projectReady', 'Project Ready')}
                </span>
              </div>
              <button
                onClick={() => setFinalOutputOpen(true)}
                className="flex items-center justify-center gap-2 bg-yellow-400 hover:bg-yellow-300 active:scale-95 text-black px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all w-full shadow-sm"
              >
                <FolderOpen size={14} strokeWidth={3} />
                {translate('office.panels.inspectorPanel.viewFinalOutput', 'View Final Output')}
              </button>
            </div>
          ) : isChatting ? null : (
            <button
              onClick={handleStartChat}
              disabled={!canChat}
              title={!canChat ? reason : undefined}
              className={`w-full h-10 px-4 rounded-xl flex items-center justify-center gap-2 transition-all active:scale-95 text-[10px] font-black uppercase tracking-widest ${
                canChat
                  ? 'bg-darkDelegation text-white border-none shadow-md'
                  : 'bg-zinc-50 text-zinc-300 border border-transparent cursor-not-allowed'
              }`}
            >
              {canChat ? (
                <>
                  <MessageSquare size={13} className="text-white" />
                  {translate('office.panels.inspectorPanel.openChat', 'Open Chat')}
                </>
              ) : (
                <>
                  <Lock size={12} className="opacity-40" />
                  {reason}
                </>
              )}
            </button>
          )}
        </div>
      )}
    </>
  )
}
