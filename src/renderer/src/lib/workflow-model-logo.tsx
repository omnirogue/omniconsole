import { ClaudeIcon, GeminiIcon, MiniMaxIcon, OpenAIIcon } from '@/components/status-bar/icons'
import { ModelMakerGlyph } from './model-maker-glyph'
import type { ModelMakerGlyphId } from './model-maker-glyphs'
import { ProviderIcon } from './provider-icon-catalog'
import { WorkflowProviderIcon } from './workflow-provider-icon'
import {
  localWorkflowRouteNamesModel,
  type LocalWorkflowRoute
} from '../../../shared/local-workflow-seats'
import { modelLineage, type ModelLineage } from '../../../shared/model-lineage'

const MAKER_GLYPHS: Partial<Record<ModelLineage, ModelMakerGlyphId>> = {
  meta: 'meta',
  mistral: 'mistral',
  deepseek: 'deepseek',
  alibaba: 'alibaba',
  moonshot: 'moonshot',
  zhipu: 'zhipu',
  nvidia: 'nvidia',
  cohere: 'cohere',
  bytedance: 'bytedance',
  amazon: 'amazon',
  ai21: 'ai21'
}

/**
 * The logo a workflow model is shown with. A signed-in family keeps its own icon; a model reached
 * through OpenRouter or Ollama shows the mark of the company that made it, so the same model
 * reads the same whichever route runs it. A maker with no mark falls back to the route's.
 */
export function WorkflowModelLogo({
  route,
  model,
  size = 14
}: {
  route: LocalWorkflowRoute
  model?: string
  size?: number
}): React.JSX.Element {
  if (!localWorkflowRouteNamesModel(route)) {
    return <WorkflowProviderIcon agent={route} size={size} />
  }
  const lineage = modelLineage(route, model)
  if (lineage === 'anthropic') {
    return <ClaudeIcon size={size} />
  }
  if (lineage === 'openai') {
    return <OpenAIIcon size={size} />
  }
  if (lineage === 'google') {
    return <GeminiIcon size={size} />
  }
  if (lineage === 'xai') {
    return <ProviderIcon id="xai" size={size} />
  }
  if (lineage === 'minimax') {
    return <MiniMaxIcon size={size} />
  }
  const glyph = MAKER_GLYPHS[lineage]
  return glyph ? (
    <ModelMakerGlyph id={glyph} size={size} />
  ) : (
    <WorkflowProviderIcon agent={route} size={size} />
  )
}
