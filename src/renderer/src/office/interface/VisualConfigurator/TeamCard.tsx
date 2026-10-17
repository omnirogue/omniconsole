// @ts-nocheck
import { Edit2, Trash2, Users, X } from 'lucide-react'
import React, { useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { AgenticSystem } from '../../data/agents'
import { DEFAULT_AGENTIC_SET_ID, getAllAgents } from '../../data/agents'
import { DEFAULT_MODELS } from '../../core/llm/constants'
import { USER_COLOR } from '../../theme/brand'
import { useTeamStore } from '../../integration/store/teamStore'
import { useSceneManager } from '../../simulation/SceneContext'
import { getBrightness } from './colorUtils'
import { ColorPicker } from './ColorPicker'
import { TeamOutputConfig } from './TeamOutputConfig'
import { TeamOutputBadge } from '../components/TeamOutputBadge'

type TeamCardProps = {
  system: AgenticSystem
  isSelected: boolean
  isActive: boolean
  isPredefined: boolean
  mode: 'view' | 'edit'
  onSelectTeam: (id: string) => void
  onModeChange: (mode: 'view' | 'edit') => void
}

export const TeamCard: React.FC<TeamCardProps> = (props) => {
  const isEditing = props.mode === 'edit' && props.isSelected
  // A changed team snapshot or editing session owns a fresh draft and confirmation state.
  return <TeamCardSession key={JSON.stringify([props.system, isEditing])} {...props} />
}

const TeamCardSession: React.FC<TeamCardProps> = ({
  system,
  isSelected,
  isActive,
  mode,
  onSelectTeam,
  onModeChange
}) => {
  const setActiveTeam = useTeamStore((state) => state.setActiveTeam)
  const updateSystem = useTeamStore((state) => state.updateSystem)
  const deleteCustomSystem = useTeamStore((state) => state.deleteCustomSystem)
  const selectedAgentSetId = useTeamStore((state) => state.selectedAgentSetId)
  const scene = useSceneManager()

  const [localEditData, setLocalEditData] = useState<Partial<AgenticSystem>>(() => ({
    teamName: system.teamName || '',
    teamType: system.teamType || '',
    teamDescription:
      system.teamDescription ||
      translate('office.visual.teamCard.defaultDescription', 'A custom agentic team.'),
    color: system.color || '#A855F7',
    outputType: system.outputType || 'text',
    outputModel: system.outputModel || DEFAULT_MODELS.text,
    outputAutoApprove:
      system.outputAutoApprove !== undefined
        ? system.outputAutoApprove
        : system.outputType === 'text'
  }))
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [hasColorSuggestion, setHasColorSuggestion] = useState(false)

  const isEditing = mode === 'edit' && isSelected
  const agentCount = useMemo(() => getAllAgents(system).length, [system])

  const hasUnsavedChanges = useMemo(() => {
    return (
      localEditData.teamName !== (system.teamName || '') ||
      localEditData.teamType !== (system.teamType || '') ||
      localEditData.teamDescription !== (system.teamDescription || '') ||
      localEditData.color !== (system.color || '#A855F7') ||
      localEditData.outputType !== (system.outputType || 'text') ||
      localEditData.outputModel !== (system.outputModel || DEFAULT_MODELS.text) ||
      localEditData.outputAutoApprove !== system.outputAutoApprove
    )
  }, [localEditData, system])

  const isFormValid = !!(
    localEditData.teamName?.trim() &&
    localEditData.teamType?.trim() &&
    localEditData.teamDescription?.trim() &&
    !hasColorSuggestion
  )

  const handleSwitch = (e: React.MouseEvent) => {
    e.stopPropagation()
    scene?.resetScene()
    setActiveTeam(system.id)
  }

  const handleSave = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!isFormValid) {
      setErrorMsg(
        translate(
          'office.visual.teamCard.requiredFields',
          'Please fill Name, Type and Description or delete the team.'
        )
      )
      return
    }
    updateSystem(system.id, localEditData)
    onModeChange('view')
  }

  const handleCloseEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!isFormValid) {
      if (hasColorSuggestion) {
        setErrorMsg(
          translate(
            'office.visual.teamCard.darkerColor',
            'Please choose a darker color (use suggestion or pick another) before saving.'
          )
        )
      } else {
        setErrorMsg(
          translate(
            'office.visual.teamCard.requiredFields',
            'Please fill Name, Type and Description or delete the team.'
          )
        )
      }
      return
    }
    if (hasUnsavedChanges) {
      setErrorMsg(
        translate(
          'office.visual.teamCard.unsavedChanges',
          'Unsaved changes will be lost. Save or close again to discard.'
        )
      )
      if (
        errorMsg ===
        translate(
          'office.visual.teamCard.unsavedChanges',
          'Unsaved changes will be lost. Save or close again to discard.'
        )
      ) {
        onModeChange('view')
      }
      return
    }
    onModeChange('view')
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowDeleteConfirm(true)
    setErrorMsg(translate('office.visual.teamCard.deleteConfirmation', 'Delete this team?'))
  }

  const confirmDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (system.id === selectedAgentSetId) {
      scene?.resetScene()
      setActiveTeam(DEFAULT_AGENTIC_SET_ID)
    }
    deleteCustomSystem(system.id)
    onModeChange('view')
  }

  const handleColorChange = (newColor: string) => {
    setLocalEditData((prev) => ({ ...prev, color: newColor }))

    // Check if new color is too light to update form validity status
    const brightness = getBrightness(newColor)
    setHasColorSuggestion(brightness > 180)
    setErrorMsg(null)
  }

  return (
    <div
      onClick={() => onSelectTeam(system.id)}
      className={`group relative p-3.5 rounded-2xl transition-all cursor-pointer border-[3px] ${
        isSelected ? 'bg-zinc-50/50 shadow-sm' : 'bg-white hover:border-zinc-200/50'
      }`}
      style={{
        borderColor: isSelected ? system.color : isActive ? `${system.color}50` : 'transparent'
      }}
    >
      {isEditing && (
        <div className="mb-3">
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-100">
            <div className="flex items-center gap-2">
              <h3 className="text-[9px] font-black uppercase tracking-[0.1em] text-darkDelegation">
                {translate('office.visual.teamCard.edit', 'Edit Team')}
              </h3>
            </div>
            <button
              onClick={handleCloseEdit}
              className="p-1 hover:bg-zinc-200 rounded-lg text-zinc-400"
            >
              <X size={14} strokeWidth={3} />
            </button>
          </div>
          {errorMsg && (
            <div className="flex items-center justify-between gap-2 p-2 bg-red-50 border border-red-100 rounded-xl mb-2">
              <p className="text-[9px] font-bold text-red-600 leading-tight uppercase tracking-tight">
                {errorMsg}
              </p>
              {showDeleteConfirm && (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setShowDeleteConfirm(false)
                      setErrorMsg(null)
                    }}
                    className="px-2 py-0.5 bg-white border border-red-100 text-red-400 rounded-md text-[8px] font-black uppercase tracking-wider"
                  >
                    {translate('office.visual.teamCard.cancel', 'Cancel')}
                  </button>
                  <button
                    onClick={confirmDelete}
                    className="px-2 py-0.5 bg-red-500 text-white rounded-md text-[8px] font-black uppercase tracking-wider"
                  >
                    {translate('office.visual.teamCard.confirm', 'OK')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {isSelected && !isEditing && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onModeChange('edit')
          }}
          className="absolute top-3.5 right-3.5 flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 hover:bg-zinc-200 rounded-xl text-darkDelegation text-[9px] font-black uppercase tracking-widest transition-all opacity-0 group-hover:opacity-100 z-10"
        >
          <Edit2 size={12} strokeWidth={2.5} />
          {translate('office.visual.teamCard.edit', 'Edit Team')}
        </button>
      )}

      <div className="flex flex-col">
        {/* Header Row: Badge + Name/Type */}
        <div className="flex items-start gap-3.5 mb-3">
          {!isEditing && (
            <div className="relative shrink-0">
              <div
                className="h-9 px-3 rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-black/5"
                style={{ backgroundColor: system.color }}
              >
                <Users size={14} className="text-white opacity-90" strokeWidth={3} />
                <span className="text-xs font-black text-white leading-none">{agentCount}</span>
              </div>
            </div>
          )}

          <div className="flex-1 min-w-0 flex flex-col">
            {isEditing ? (
              <div className="space-y-1 mb-2">
                <label className="text-[7px] font-black uppercase text-zinc-400 ml-1">
                  {translate('office.visual.teamCard.color', 'Team Color')}
                </label>
                <div className="px-1">
                  <ColorPicker
                    color={localEditData.color || '#A855F7'}
                    onChange={handleColorChange}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-0.5">
                <h4
                  className={`text-[11px] font-black leading-tight uppercase tracking-wider truncate mb-0.5 ${system.teamName ? 'text-darkDelegation' : 'text-zinc-300'}`}
                >
                  {system.teamName || translate('office.visual.teamCard.untitled', 'Untitled Team')}
                </h4>
                <p
                  className={`text-[9px] font-bold uppercase tracking-[0.1em] ${system.teamType ? 'text-zinc-400' : 'text-zinc-200'}`}
                >
                  {system.teamType ||
                    translate('office.visual.teamCard.unspecifiedType', 'Unspecified Type')}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Body Content: Spans full width */}
        <div className="flex flex-col flex-1 min-w-0">
          {isEditing ? (
            <div className="space-y-2 mb-3" onClick={(e) => e.stopPropagation()}>
              <div className="space-y-1">
                <label className="text-[7px] font-black uppercase text-zinc-400 ml-1">
                  {translate('office.visual.teamCard.name', 'Team Name')}
                </label>
                <input
                  value={localEditData.teamName || ''}
                  onChange={(e) => {
                    setLocalEditData((prev) => ({ ...prev, teamName: e.target.value }))
                    setErrorMsg(null)
                  }}
                  className="w-full bg-white border border-zinc-100 text-[13px] font-medium rounded-xl px-2.5 py-1.5 outline-none transition-colors"
                  style={{ '--tw-focus-border-color': USER_COLOR } as React.CSSProperties}
                  onFocus={(e) => (e.target.style.borderColor = USER_COLOR)}
                  onBlur={(e) => (e.target.style.borderColor = '#f4f4f5')}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[7px] font-black uppercase text-zinc-400 ml-1">
                  {translate('office.visual.teamCard.type', 'Team Type')}
                </label>
                <input
                  value={localEditData.teamType || ''}
                  onChange={(e) => {
                    setLocalEditData((prev) => ({ ...prev, teamType: e.target.value }))
                    setErrorMsg(null)
                  }}
                  className="w-full bg-white border border-zinc-100 text-[13px] font-medium rounded-xl px-2.5 py-1.5 outline-none transition-colors"
                  onFocus={(e) => (e.target.style.borderColor = USER_COLOR)}
                  onBlur={(e) => (e.target.style.borderColor = '#f4f4f5')}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[7px] font-black uppercase text-zinc-400 ml-1">
                  {translate('office.visual.teamCard.description', 'Description')}
                </label>
                <textarea
                  value={localEditData.teamDescription || ''}
                  onChange={(e) => {
                    setLocalEditData((prev) => ({ ...prev, teamDescription: e.target.value }))
                    setErrorMsg(null)
                  }}
                  className="w-full bg-white border border-zinc-100 text-[13px] font-medium rounded-xl p-2.5 outline-none resize-none h-20 leading-snug transition-colors"
                  onFocus={(e) => (e.target.style.borderColor = USER_COLOR)}
                  onBlur={(e) => (e.target.style.borderColor = '#f4f4f5')}
                />
              </div>
              <TeamOutputConfig localEditData={localEditData} setLocalEditData={setLocalEditData} />

              <button
                onClick={handleSave}
                disabled={!isFormValid}
                className={`w-full py-2.5 mt-1 rounded-xl text-[10px] font-black uppercase tracking-[0.1em] transition-all shadow-lg ${isFormValid ? 'bg-darkDelegation text-white shadow-black/10' : 'bg-zinc-50 text-zinc-300 shadow-none cursor-not-allowed'}`}
              >
                {translate('office.visual.teamCard.save', 'Save Changes')}
              </button>
            </div>
          ) : (
            <div className="space-y-0.5 mb-2.5 px-2">
              <TeamOutputBadge system={system} className="mt-1" />

              <p
                className={`text-[10px] leading-relaxed font-medium mt-2 line-clamp-2 ${system.teamDescription ? 'text-zinc-500/80' : 'text-zinc-300 italic'}`}
              >
                {system.teamDescription ||
                  translate('office.visual.teamCard.noDescription', 'No description provided.')}
              </p>
            </div>
          )}

          <div
            className={`flex items-center justify-between mt-auto pt-2 ${isEditing ? 'border-t border-zinc-100/30' : ''}`}
          >
            <div className="flex items-center gap-1.5 px-2 py-1 bg-zinc-50 text-[8px] font-black text-zinc-400 rounded-lg">
              <Users size={10} strokeWidth={3} />
              {agentCount === 1
                ? translate('office.visual.teamCard.agentCountSingle', '{{count}} AGENT', {
                    count: agentCount
                  })
                : translate('office.visual.teamCard.agentCountMultiple', '{{count}} AGENTS', {
                    count: agentCount
                  })}
            </div>
            <div className="flex items-center gap-2">
              {isActive && !isEditing && (
                <div
                  className="px-2 py-0.5 rounded-full text-white text-[7px] font-black uppercase tracking-[0.15em]"
                  style={{ backgroundColor: system.color }}
                >
                  {translate('office.visual.teamCard.active', 'Active')}
                </div>
              )}
              {isSelected && !isActive && !isEditing && (
                <button
                  onClick={handleSwitch}
                  className="px-3 py-1.5 bg-darkDelegation text-white rounded-full text-[9px] font-black uppercase tracking-wider shadow-md"
                >
                  {translate('office.visual.teamCard.switch', 'Switch')}
                </button>
              )}
              {isEditing && (
                <button
                  onClick={handleDelete}
                  className="flex items-center gap-1.5 px-2 py-1 text-red-500 hover:bg-red-50 rounded-lg text-[8px] font-black uppercase tracking-widest transition-all"
                >
                  <Trash2 size={12} />
                  {translate('office.visual.teamCard.delete', 'Delete Team')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
