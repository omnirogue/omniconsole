import { AgentIcon } from './agent-catalog'
import { ModelMakerGlyph } from './model-maker-glyph'
import { ProviderIcon } from './provider-icon-catalog'
import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'

export function WorkflowProviderIcon({
  agent,
  size
}: {
  agent: LocalWorkflowRoute
  size?: number
}) {
  if (agent === 'openrouter') {
    return <ProviderIcon id="openrouter" size={size} />
  }
  return agent === 'ollama' ? (
    <ModelMakerGlyph id="ollama" size={size} />
  ) : (
    <AgentIcon agent={agent} size={size} />
  )
}
