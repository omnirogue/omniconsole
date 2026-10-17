// @ts-nocheck
import { useState, useEffect } from 'react'
import { useCoreStore, type FinalAssetParams } from '../integration/store/coreStore'
import { useActiveTeam } from '../integration/store/teamStore'
import { useSceneManager } from '../simulation/SceneContext'
import { Sparkles, Image as ImageIcon, Video, Music, Type, X, Check } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { OutputReviewParameters } from './OutputReviewParameters'
import { OutputReviewResetConfirmation } from './OutputReviewResetConfirmation'

export function OutputReviewModal() {
  const {
    isReviewingOutput,
    setReviewingOutput,
    pendingOutputPrompt,
    pendingOutputParams,
    resetProject,
    referenceImages
  } = useCoreStore()

  const activeTeam = useActiveTeam()
  const scene = useSceneManager()
  const [prompt, setPrompt] = useState(pendingOutputPrompt)
  const [params, setParams] = useState<FinalAssetParams>(pendingOutputParams)
  const [isConfirmingReset, setIsConfirmingReset] = useState(false)

  // Sync internal state when store changes
  useEffect(() => {
    if (isReviewingOutput) {
      setPrompt(pendingOutputPrompt)
      setParams(pendingOutputParams)
      setIsConfirmingReset(false)
    }
  }, [isReviewingOutput, pendingOutputPrompt, pendingOutputParams])

  if (!isReviewingOutput) {
    return null
  }

  const handleGenerate = async () => {
    const brain = scene?.getLeadBrain()
    if (brain) {
      // Trigger the actual generation
      await brain.processFinalAsset(prompt, params)
    }
  }

  const handleCancelAndReset = () => {
    setIsConfirmingReset(true)
  }

  const confirmReset = () => {
    resetProject()
    setIsConfirmingReset(false)
    setReviewingOutput(false)
  }

  const updateParam = <Key extends keyof FinalAssetParams>(
    key: Key,
    value: FinalAssetParams[Key]
  ) => {
    setParams((prev) => ({ ...prev, [key]: value }))
  }

  const Icon =
    {
      image: ImageIcon,
      video: Video,
      music: Music,
      text: Type
    }[activeTeam.outputType] || Sparkles

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-darkDelegation/40 backdrop-blur-md p-4"
      onClick={handleCancelAndReset}
    >
      <div
        className="bg-white border border-black/10 rounded-[32px] w-180 max-w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-6 border-b border-zinc-100 bg-white">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-darkDelegation flex items-center justify-center text-white shadow-lg">
              <Icon size={24} />
            </div>
            <div>
              <h2 className="text-sm font-black uppercase tracking-widest text-darkDelegation flex items-center gap-2">
                {translate('office.panels.outputReviewModal.title', 'Review & Optimize Output')}
              </h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                {translate(
                  'office.panels.outputReviewModal.description',
                  "The lead agent has synthesized the team's work. Fine-tune it before final generation."
                )}
              </p>
            </div>
          </div>
          <button
            onClick={handleCancelAndReset}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700 transition-all active:scale-90"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scrollbar-sleek px-8 py-8 space-y-8 bg-zinc-50/30">
          {/* Prompt Editor */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
                {translate('office.panels.outputReviewModal.promptLabel', 'PROMPT / CONTENT')}
              </label>
              <div className="px-2 py-0.5 bg-zinc-100 rounded text-[9px] font-bold text-zinc-400 tracking-tighter">
                {translate('office.panels.outputReviewModal.editable', 'EDITABLE')}
              </div>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full h-40 bg-white border border-zinc-200 rounded-2xl p-4 text-sm text-zinc-700 leading-relaxed font-sans focus:ring-2 focus:ring-darkDelegation outline-none resize-none shadow-sm"
              placeholder={translate(
                'office.panels.outputReviewModal.promptPlaceholder',
                'Enter the final generation prompt...'
              )}
            />
          </div>

          {/* Parameters Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <OutputReviewParameters
              params={params}
              updateParam={updateParam}
              outputType={activeTeam.outputType}
              outputModel={activeTeam.outputModel}
            />

            <div className="bg-darkDelegation rounded-[24px] p-6 text-white space-y-4 shadow-xl">
              <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500">
                {translate(
                  'office.panels.outputReviewModal.systemInformation',
                  'System Information'
                )}
              </h3>
              <div className="space-y-4">
                <div>
                  <p className="text-[9px] text-zinc-500 uppercase font-bold tracking-widest">
                    {translate('office.panels.outputReviewModal.team', 'Team')}
                  </p>
                  <p className="text-xs font-black">{activeTeam.teamName}</p>
                </div>
                <div>
                  <p className="text-[9px] text-zinc-500 uppercase font-bold tracking-widest">
                    {translate('office.panels.outputReviewModal.outputType', 'Output Type')}
                  </p>
                  <p className="text-xs font-black capitalize">{activeTeam.outputType}</p>
                </div>

                {referenceImages.length > 0 && (
                  <div className="pt-6 border-t border-white/10 space-y-3">
                    <p className="text-[9px] text-zinc-500 uppercase font-bold tracking-widest">
                      {translate(
                        'office.panels.outputReviewModal.visualInspiration',
                        'Visual Inspiration'
                      )}
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {referenceImages.map((img, idx) => (
                        <div
                          key={idx}
                          className="aspect-square rounded-lg overflow-hidden border border-white/5 bg-white/5"
                        >
                          <img
                            src={img}
                            alt={translate(
                              'office.panels.outputReviewModal.referenceImageAlt',
                              'Ref'
                            )}
                            className="w-full h-full object-cover opacity-80 hover:opacity-100 transition-opacity"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pt-4 border-t border-white/10">
                  <p className="text-[10px] leading-relaxed text-zinc-400 italic">
                    {translate(
                      'office.panels.outputReviewModal.finalPhaseDescription',
                      '"This is the final terminal phase. You can adjust the parameters and the synthesized prompt to get the best result. Once approved, the simulation will complete and your asset will be generated."'
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-8 py-6 border-t border-zinc-100 flex justify-end items-center bg-white gap-3">
          <button
            onClick={handleCancelAndReset}
            className="px-6 py-3 bg-white border border-zinc-200 text-zinc-500 rounded-2xl text-[10px] font-black uppercase tracking-[0.15em] hover:bg-zinc-50 hover:text-red-500 hover:border-red-500 transition-all active:scale-[0.98]"
          >
            {translate(
              'office.panels.outputReviewModal.cancelAndResetProject',
              'Cancel & Reset Project'
            )}
          </button>

          <button
            onClick={handleGenerate}
            className="px-8 py-3 bg-darkDelegation text-white rounded-2xl text-[10px] font-black uppercase tracking-[0.15em] hover:bg-black active:scale-[0.98] transition-all shadow-lg shadow-black/10 flex items-center gap-2"
          >
            <Check size={14} strokeWidth={3} />
            {translate('office.panels.outputReviewModal.approveAndGenerate', 'Approve & Generate')}
          </button>
        </div>
      </div>

      {/* Confirmation Modal Overlay */}
      {isConfirmingReset && (
        <OutputReviewResetConfirmation
          onConfirm={confirmReset}
          onCancel={() => setIsConfirmingReset(false)}
        />
      )}
    </div>
  )
}
