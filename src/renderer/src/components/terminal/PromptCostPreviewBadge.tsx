import { useAppStore } from '@/store'
import { PromptCostEstimatorBadge } from './PromptCostEstimatorBadge'

/** OmniSI previews only: no input rate reaches the renderer yet, so cost stays "unavailable". */
export function PromptCostPreviewBadge({ prompt }: { prompt: string }) {
  const enabled = useAppStore((state) => state.settings?.experimentalOmniSiPreviews === true)
  return enabled ? <PromptCostEstimatorBadge prompt={prompt} /> : null
}
