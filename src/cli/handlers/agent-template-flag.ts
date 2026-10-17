import type { AgentTemplateRecord } from '../../shared/agent-template-edits'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'

/**
 * `--agent-template` for a launch: a blank value refuses, and the host is asked for its templates
 * first, so an older host that would silently drop the param refuses before any session starts.
 */
export async function agentTemplateLaunchFlag(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<string | undefined> {
  if (!flags.has('agent-template')) {
    return undefined
  }
  const id = flags.get('agent-template')
  if (typeof id !== 'string' || !id.trim()) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--agent-template needs a template id; run "omni agents list" to see them.'
    )
  }
  let templates: AgentTemplateRecord[]
  try {
    templates = (await client.call<{ templates: AgentTemplateRecord[] }>('agentTemplates.list'))
      .result.templates
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'unsupported_runtime_capability',
        'This OmniConsole host cannot record an agent template. Update it, or launch without --agent-template.',
        { capability: 'agentTemplates.list', effectsApplied: false }
      )
    }
    throw error
  }
  if (!templates.some((template) => template.id === id)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown agent template "${id}". Run "omni agents list" to see the available ids.`
    )
  }
  return id
}
