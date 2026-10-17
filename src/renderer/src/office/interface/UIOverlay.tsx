// @ts-nocheck

import React, { useState } from 'react'
import { getAllAgents, getAllCharacters } from '../data/agents'
import { useUiStore } from '../integration/store/uiStore'
import InfoModal from './InfoModal'
import { AgentLabelBubble } from './components/AgentLabelBubble'

import { MessageSquareWarning, PartyPopper, Siren, Loader2 } from 'lucide-react'
import { useCoreStore } from '../integration/store/coreStore'
import { useActiveTeam } from '../integration/store/teamStore'
import { USER_COLOR } from '../theme/brand'

type AlertBubbleProps = {
  icon: React.ReactNode
  position: { x: number; y: number }
  visible: boolean
  color?: string
  onClick?: () => void
}

const AlertBubble: React.FC<AlertBubbleProps> = ({
  icon,
  position,
  visible,
  color = '#facc15',
  onClick
}) => {
  if (!visible) {
    return null
  }

  return (
    <div
      className={`absolute z-20 ${onClick ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none'}`}
      style={{
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%) translateY(-10px)'
      }}
      onClick={(e) => {
        if (onClick) {
          e.stopPropagation()
          onClick()
        }
      }}
    >
      <div
        className={`bg-darkDelegation/90 backdrop-blur-md p-1.5 rounded-full border border-white/10 shadow-xl flex items-center justify-center hover:scale-110 active:scale-95 transition-transform ${onClick ? 'hover:border-white/30' : ''}`}
        style={{ color }}
      >
        {icon}
      </div>
    </div>
  )
}

const UIOverlay: React.FC = () => {
  const {
    selectedNpcIndex,
    selectedPosition,
    hoveredNpcIndex,
    hoveredPoiLabel,
    hoverPosition,
    npcScreenPositions,
    setSelectedNpc
  } = useUiStore()
  const [isHelpOpen, setHelpOpen] = useState(false)
  const { tasks, phase, isGeneratingAsset } = useCoreStore()
  const system = useActiveTeam()
  const npcAgents = getAllAgents(system)
  const allPossibleAgents = getAllCharacters(system)

  const selectedAgent =
    selectedNpcIndex != null
      ? (allPossibleAgents.find((a) => a.index === selectedNpcIndex) ?? null)
      : null
  const hoveredAgent =
    hoveredNpcIndex != null
      ? (allPossibleAgents.find((a) => a.index === hoveredNpcIndex) ?? null)
      : null

  return (
    <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden select-none">
      {/* 1. Parallel Alert Bubbles System */}
      {npcAgents.map((agent) => {
        const pos = npcScreenPositions[agent.index]
        if (!pos) {
          return null
        }

        // Condition: Alert disappears when hovered
        const isCurrentlyHovered =
          hoveredNpcIndex === agent.index || selectedNpcIndex === agent.index
        if (isCurrentlyHovered) {
          return null
        }

        let alertIcon: React.ReactNode = null
        let alertColor = '#facc15' // Default yellow

        // Check specific conditions
        // - Lead Agent (index 1) idle: siren
        if (agent.index === system.leadAgent.index && isGeneratingAsset) {
          alertIcon = <Loader2 size={18} className="animate-spin" />
          alertColor = '#818cf8' // Indigo-400
        } else if (agent.index === system.leadAgent.index && phase === 'idle') {
          alertIcon = <Siren size={18} />
          alertColor = '#ffffff' // White for siren
        }
        // - Lead Agent (index 1) project finished: party-popper
        else if (agent.index === system.leadAgent.index && phase === 'done') {
          alertIcon = <PartyPopper size={18} />
          alertColor = '#facc15' // Yellow
        }
        // - Any agent waiting for USER approval (target 0): message-square-warning
        else {
          const pendingTask = tasks.find(
            (t) => t.status === 'on_hold' && t.assignedAgentId === agent.index
          )
          if (pendingTask) {
            alertIcon = <MessageSquareWarning size={18} />
            alertColor = USER_COLOR
          }
        }

        if (!alertIcon) {
          return null
        }

        return (
          <AlertBubble
            key={`alert-${agent.index}`}
            icon={alertIcon}
            position={pos}
            visible={true}
            color={alertColor}
            onClick={() => setSelectedNpc(agent.index)}
          />
        )
      })}

      {/* 2. Selection/Hover/Project Ready Bubble (Detailed) */}
      {(() => {
        // Priority 1: Selected Agent
        if (selectedAgent && selectedPosition) {
          return (
            <AgentLabelBubble
              agent={selectedAgent}
              position={selectedPosition}
              leadAgentIndex={system.leadAgent.index}
              userIndex={system.user.index}
              tasks={tasks}
              phase={phase}
              isGeneratingAsset={isGeneratingAsset}
            />
          )
        }

        // Priority 2: Hovered Agent with dynamic phase label (only if not selected)
        if (hoveredAgent && hoverPosition && hoveredNpcIndex !== selectedNpcIndex) {
          return (
            <AgentLabelBubble
              agent={hoveredAgent}
              position={hoverPosition}
              leadAgentIndex={system.leadAgent.index}
              userIndex={system.user.index}
              tasks={tasks}
              phase={phase}
              isGeneratingAsset={isGeneratingAsset}
            />
          )
        }

        return null
      })()}

      {/* POI Hover Bubble */}
      {hoveredPoiLabel && hoverPosition && (
        <div
          className="absolute z-10 pointer-events-none transition-all duration-75 ease-out"
          style={{
            left: hoverPosition.x,
            top: hoverPosition.y,
            transform: 'translate(-50%, -100%) translateY(-10px)'
          }}
        >
          <div className="bg-darkDelegation/90 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10 shadow-xl flex items-center gap-2 whitespace-nowrap animate-in fade-in zoom-in-95 duration-200">
            <span className="text-[10px] font-black uppercase tracking-widest text-white">
              {hoveredPoiLabel}
            </span>
          </div>
        </div>
      )}

      {/* Help Modal */}
      {isHelpOpen && <InfoModal onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

export default UIOverlay
