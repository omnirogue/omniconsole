import { Clock, Maximize, Monitor, Settings2, Sparkles } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { FinalAssetParams } from '../integration/store/coreStore'
import type { AgenticSystem } from '../data/agents'
import { AVAILABLE_MODELS } from '../core/llm/constants'
import { InfoBubble } from './components/InfoBubble'

type OutputReviewParametersProps = Pick<AgenticSystem, 'outputType' | 'outputModel'> & {
  params: FinalAssetParams
  updateParam: <Key extends keyof FinalAssetParams>(key: Key, value: FinalAssetParams[Key]) => void
}

export function OutputReviewParameters({
  outputType,
  outputModel,
  params,
  updateParam
}: OutputReviewParametersProps) {
  const renderImageControls = () => (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <label className="text-[10px] font-black uppercase tracking-widest text-zinc-400 flex items-center gap-1.5">
          <Maximize size={12} />{' '}
          {translate('office.panels.outputReviewModal.aspectRatio', 'Aspect Ratio')}
          <InfoBubble
            text={translate(
              'office.panels.outputReviewModal.aspectRatioHelp',
              'The horizontal or vertical proportions of the generated asset.'
            )}
          />
        </label>
        <select
          value={params.aspectRatio || '16:9'}
          onChange={(e) => updateParam('aspectRatio', e.target.value)}
          className="w-full bg-white border border-zinc-200 rounded-xl px-3 py-2 text-xs focus:ring-2 focus:ring-darkDelegation outline-none"
        >
          <option value="1:1">
            {translate('office.panels.outputReviewModal.squareRatio', '1:1 Square')}
          </option>
          <option value="16:9">
            {translate('office.panels.outputReviewModal.cinematicRatio', '16:9 Cinematic')}
          </option>
          <option value="9:16">
            {translate('office.panels.outputReviewModal.verticalRatio', '9:16 Vertical')}
          </option>
          <option value="4:3">
            {translate('office.panels.outputReviewModal.classicRatio', '4:3 Classic')}
          </option>
          <option value="3:2">
            {translate('office.panels.outputReviewModal.professionalRatio', '3:2 Professional')}
          </option>
        </select>
      </div>
      <div className="space-y-2">
        <label className="text-[10px] font-black uppercase tracking-widest text-zinc-400 flex items-center gap-1.5">
          <Settings2 size={12} />{' '}
          {translate('office.panels.outputReviewModal.imageSize', 'Image Size')}
          <InfoBubble
            text={translate(
              'office.panels.outputReviewModal.imageSizeHelp',
              'Target dimensions for the final image. Higher sizes offer more detail but may take longer.'
            )}
          />
        </label>
        <select
          value={params.imageSize || '1K'}
          onChange={(e) => updateParam('imageSize', e.target.value)}
          className="w-full bg-white border border-zinc-200 rounded-xl px-3 py-2 text-xs focus:ring-2 focus:ring-darkDelegation outline-none"
        >
          <option value="512">
            {translate('office.panels.outputReviewModal.fastImageSize', '512px (Fast)')}
          </option>
          <option value="1K">
            {translate('office.panels.outputReviewModal.standardImageSize', '1K (Standard)')}
          </option>
          <option value="2K">
            {translate('office.panels.outputReviewModal.highResolutionImageSize', '2K (High Res)')}
          </option>
          <option value="4K">
            {translate('office.panels.outputReviewModal.ultraImageSize', '4K (Ultra)')}
          </option>
        </select>
      </div>
    </div>
  )

  const renderVideoControls = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-[10px] font-black uppercase tracking-widest text-zinc-400 flex items-center gap-1.5">
            <Monitor size={12} />{' '}
            {translate('office.panels.outputReviewModal.resolution', 'Resolution')}
            <InfoBubble
              text={translate(
                'office.panels.outputReviewModal.resolutionHelp',
                'Video output quality. Higher resolutions increase visual fidelity and processing requirements.'
              )}
            />
          </label>
          <select
            value={params.resolution || '720p'}
            onChange={(e) => updateParam('resolution', e.target.value)}
            className="w-full bg-white border border-zinc-200 rounded-xl px-3 py-2 text-xs focus:ring-2 focus:ring-darkDelegation outline-none"
          >
            <option value="720p">
              {translate('office.panels.outputReviewModal.hdResolution', '720p HD')}
            </option>
            <option value="1080p">
              {translate('office.panels.outputReviewModal.fullHdResolution', '1080p Full HD')}
            </option>
            <option value="4k">
              {translate('office.panels.outputReviewModal.visionResolution', '4K Vision')}
            </option>
          </select>
        </div>
        <div className="space-y-2">
          <label className="text-[10px] font-black uppercase tracking-widest text-zinc-400 flex items-center gap-1.5">
            <Clock size={12} /> {translate('office.panels.outputReviewModal.duration', 'Duration')}
            <InfoBubble
              text={translate(
                'office.panels.outputReviewModal.durationHelp',
                'Total runtime of the generated video clip.'
              )}
            />
          </label>
          <select
            value={params.durationSeconds || 4}
            onChange={(e) => updateParam('durationSeconds', Number.parseInt(e.target.value))}
            className="w-full bg-white border border-zinc-200 rounded-xl px-3 py-2 text-xs focus:ring-2 focus:ring-darkDelegation outline-none"
          >
            <option value="4">
              {translate('office.panels.outputReviewModal.fourSeconds', '4 Seconds')}
            </option>
            <option value="6">
              {translate('office.panels.outputReviewModal.sixSeconds', '6 Seconds')}
            </option>
            <option value="8">
              {translate('office.panels.outputReviewModal.eightSeconds', '8 Seconds')}
            </option>
          </select>
        </div>
      </div>
    </div>
  )

  const renderModelControl = () => {
    const models = AVAILABLE_MODELS[outputType] || []

    return (
      <div className="space-y-2">
        <label className="text-[10px] font-black uppercase tracking-widest text-zinc-400 flex items-center gap-1.5">
          <Sparkles size={12} /> {translate('office.panels.outputReviewModal.output', 'Output')}
          <InfoBubble
            text={translate(
              'office.panels.outputReviewModal.outputModelHelp',
              'Select the specific Gemini model used for the final generation. Flash models are faster, Pro models are more capable.'
            )}
          />
        </label>
        <select
          value={params.model || outputModel}
          onChange={(e) => updateParam('model', e.target.value)}
          className="w-full bg-white border border-zinc-200 rounded-xl px-3 py-2 text-xs font-medium focus:ring-2 focus:ring-darkDelegation outline-none"
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {renderModelControl()}
      {outputType === 'image' && renderImageControls()}
      {outputType === 'video' && renderVideoControls()}
    </div>
  )
}
