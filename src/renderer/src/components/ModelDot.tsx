import { cn } from '@/lib/utils'
import { modelLineage, type ModelLineage } from '../../../shared/model-lineage'

export type ModelTone = ModelLineage | 'jev'

// Spelled out so Tailwind sees every class; the tokens live in main.css (--model-*).
const TONE_CLASS: Partial<Record<ModelTone, string>> & { unknown: string } = {
  anthropic: 'bg-model-anthropic',
  openai: 'bg-model-openai',
  xai: 'bg-model-xai',
  google: 'bg-model-google',
  moonshot: 'bg-model-moonshot',
  alibaba: 'bg-model-alibaba',
  jev: 'bg-model-jev',
  unknown: 'bg-model-unknown'
}

const TONE_BORDER: Partial<Record<ModelTone, string>> & { unknown: string } = {
  anthropic: 'border-model-anthropic',
  openai: 'border-model-openai',
  xai: 'border-model-xai',
  google: 'border-model-google',
  moonshot: 'border-model-moonshot',
  alibaba: 'border-model-alibaba',
  jev: 'border-model-jev',
  unknown: 'border-model-unknown'
}

/** A border in the model's colour, for a chip that already shows the model's icon. */
export function modelToneBorderClass(agent: string | null | undefined, model?: string | null) {
  return TONE_BORDER[modelTone(agent, model)] ?? TONE_BORDER.unknown
}

/** The family colour of an agent and model (JEV is its own), from the one lineage table. */
export function modelTone(agent: string | null | undefined, model?: string | null): ModelTone {
  return agent === 'jev' ? 'jev' : modelLineage(agent, model)
}

/**
 * A model's colour, drawn beside its name or icon so the same model reads the same everywhere.
 * Decorative only: the name next to it always says which model it is.
 */
export function ModelDot({
  agent,
  model,
  className
}: {
  agent: string | null | undefined
  model?: string | null
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      data-model-tone={modelTone(agent, model)}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        TONE_CLASS[modelTone(agent, model)] ?? TONE_CLASS.unknown,
        className
      )}
    />
  )
}
