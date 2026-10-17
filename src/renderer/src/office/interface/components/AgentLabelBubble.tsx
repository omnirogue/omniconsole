import type { AgentNode } from '../../data/agents'
import type { Task } from '../../integration/store/coreStore'
import { translate } from '@/i18n/i18n'

type PhaseLabel = { text: string; className: string }

function getAgentPhaseLabel(
  agentIndex: number,
  leadAgentIndex: number,
  tasks: Task[],
  phase: string,
  isGeneratingAsset: boolean,
  fallback: string
): PhaseLabel {
  if (isGeneratingAsset && agentIndex === leadAgentIndex) {
    return {
      text: translate('office.panels.UIOverlay.delivering', 'Delivering...'),
      className: 'text-indigo-400 animate-pulse'
    }
  }
  if (agentIndex === leadAgentIndex && phase === 'done') {
    return {
      text: translate('office.panels.UIOverlay.projectReady', 'Project Ready!'),
      className: 'text-yellow-400'
    }
  }
  const holdTask = tasks.find(
    (t) => t.assignedAgentId === agentIndex && t.status === 'on_hold' && t.requiresUserApproval
  )
  if (holdTask && phase !== 'done') {
    return {
      text: translate('office.panels.UIOverlay.approvalNeeded', 'Approval Needed'),
      className: 'text-[#7EACEA]'
    }
  }
  const activeTask = tasks.find(
    (t) => t.assignedAgentId === agentIndex && t.status === 'in_progress'
  )
  if (activeTask) {
    return {
      text: translate('office.panels.UIOverlay.working', 'Working'),
      className: 'text-emerald-400'
    }
  }
  return { text: fallback, className: 'text-white/70' }
}

type AgentLabelBubbleProps = {
  agent: Pick<AgentNode, 'index' | 'name' | 'color'>
  position: { x: number; y: number }
  leadAgentIndex: number
  userIndex: number
  tasks: Task[]
  phase: string
  isGeneratingAsset: boolean
}

export function AgentLabelBubble({
  agent,
  position,
  leadAgentIndex,
  userIndex,
  tasks,
  phase,
  isGeneratingAsset
}: AgentLabelBubbleProps) {
  const isLeadAgentProjectReady = agent.index === leadAgentIndex && phase === 'done'
  const label = getAgentPhaseLabel(agent.index, leadAgentIndex, tasks, phase, isGeneratingAsset, '')
  return (
    <div
      className="absolute z-25 pointer-events-none transition-all duration-75 ease-out"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%) translateY(-10px)'
      }}
    >
      <div className="bg-darkDelegation/90 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10 shadow-xl flex items-center gap-2 whitespace-nowrap animate-in fade-in zoom-in-95 duration-200">
        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: agent.color }} />
        <div className="flex items-center gap-1.5">
          {agent.index === userIndex ? (
            <span className="text-[10px] font-black uppercase tracking-widest text-white">
              {translate('office.panels.UIOverlay.currentUser', '{{name}} (You)', {
                name: agent.name
              })}
            </span>
          ) : isLeadAgentProjectReady ? (
            <span className={`text-[10px] font-black uppercase tracking-widest ${label.className}`}>
              {label.text}
            </span>
          ) : (
            <>
              <span className="text-[10px] font-black uppercase tracking-widest text-white">
                {agent.name}
              </span>
              {label.text && (
                <>
                  <span className="text-[10px] font-medium uppercase tracking-widest text-white/40">
                    ·
                  </span>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-widest ${label.className}`}
                  >
                    {label.text}
                  </span>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
