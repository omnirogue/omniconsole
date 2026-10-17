import type { Dispatch, SetStateAction } from 'react'
import { translate } from '@/i18n/i18n'
import type { AgenticSystem } from '../../data/agents'
import type { ModelType } from '../../core/llm/constants'
import { DEFAULT_MODELS, AVAILABLE_MODELS } from '../../core/llm/constants'
import { InfoBubble } from '../components/InfoBubble'

type TeamOutputConfigProps = {
  localEditData: Partial<AgenticSystem>
  setLocalEditData: Dispatch<SetStateAction<Partial<AgenticSystem>>>
}

export const TeamOutputConfig = ({ localEditData, setLocalEditData }: TeamOutputConfigProps) => {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[7px] font-black uppercase text-zinc-400 ml-1">
            {translate('office.visual.teamOutput.type', 'Output Type')}
          </label>
          <select
            value={localEditData.outputType || 'text'}
            onChange={(e) => {
              const newType = e.target.value as keyof typeof DEFAULT_MODELS
              setLocalEditData((prev) => ({
                ...prev,
                outputType: newType,
                outputModel: DEFAULT_MODELS[newType] || prev.outputModel,
                outputAutoApprove: newType === 'text'
              }))
            }}
            className="w-full bg-white border border-zinc-100 text-[11px] font-bold rounded-xl px-2.5 py-1.5 outline-none cursor-pointer"
          >
            <option value="text">{translate('office.visual.teamOutput.text', 'TEXT')}</option>
            <option value="image">{translate('office.visual.teamOutput.image', 'IMAGE')}</option>
            <option value="music">{translate('office.visual.teamOutput.music', 'MUSIC')}</option>
            <option value="video">{translate('office.visual.teamOutput.video', 'VIDEO')}</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[7px] font-black uppercase text-zinc-400 ml-1">
            {translate('office.visual.teamOutput.model', 'Output Model')}
          </label>
          <select
            value={localEditData.outputModel || DEFAULT_MODELS.text}
            onChange={(e) => setLocalEditData((prev) => ({ ...prev, outputModel: e.target.value }))}
            className="w-full bg-white border border-zinc-100 text-[10px] font-bold rounded-xl px-2.5 py-1.5 outline-none cursor-pointer lowercase"
          >
            {(AVAILABLE_MODELS[localEditData.outputType as ModelType] || []).map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center justify-between p-2.5 bg-zinc-50 border border-zinc-100/50 rounded-xl mt-0.5">
        <div className="flex flex-col">
          <div className="flex items-center gap-1">
            <span className="text-[8px] font-black uppercase text-darkDelegation tracking-wider">
              {translate('office.visual.teamOutput.autoApprove', 'Auto-Approve Output')}
            </span>
            <InfoBubble
              text={translate(
                'office.visual.teamOutput.autoApproveHelp',
                'When enabled, the team will generate the final asset immediately after finishing all tasks without waiting for your review.'
              )}
            />
          </div>
          <span className="text-[7px] text-zinc-400 font-bold leading-tight">
            {translate(
              'office.visual.teamOutput.autoApproveDescription',
              'Generate asset without review'
            )}
          </span>
        </div>
        <button
          type="button"
          onClick={() =>
            setLocalEditData((prev) => ({
              ...prev,
              outputAutoApprove: !prev.outputAutoApprove
            }))
          }
          className={`w-8 h-4 rounded-full transition-all relative ${localEditData.outputAutoApprove !== false ? 'bg-darkDelegation shadow-[0_0_8px_rgba(0,0,0,0.15)]' : 'bg-zinc-200'}`}
        >
          <div
            className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${localEditData.outputAutoApprove !== false ? 'left-[16px]' : 'left-[4px]'}`}
          />
        </button>
      </div>
    </>
  )
}
