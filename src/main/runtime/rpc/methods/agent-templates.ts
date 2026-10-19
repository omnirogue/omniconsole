import { z } from 'zod'
import type { AgentTemplateSettings } from '../../../../shared/agent-templates'
import {
  agentTemplateRecords,
  applyAgentTemplateEdit,
  removeAgentTemplate
} from '../../../../shared/agent-template-edits'
import {
  resolveSessionAgentTemplate,
  type SessionAgentTemplate
} from '../../../../shared/session-agent-template'
import { defineMethod, InvalidArgumentError, type RpcMethod } from '../core'

/** Additive launch param: the id is resolved against this host's settings when the session starts. */
export const AgentTemplateIdParam = z.string().min(1).max(64)

/** An unknown id refuses the launch; it never falls back to Default or another template. */
export function resolveAgentTemplateParam(
  runtime: { getAgentTemplateSettings(): AgentTemplateSettings | undefined },
  id: string | undefined
): SessionAgentTemplate | undefined {
  if (id === undefined) {
    return undefined
  }
  const resolved = resolveSessionAgentTemplate(runtime.getAgentTemplateSettings(), id)
  if (!resolved.ok) {
    throw new InvalidArgumentError(resolved.message)
  }
  return resolved.template
}

const SetParams = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().optional(),
    description: z.string().optional(),
    instructions: z.string(),
    preferredModel: z.string().optional(),
    preferredAgent: z.enum(['claude', 'codex', 'grok', 'gemini']).optional(),
    skills: z.array(z.string().min(1).max(80)).max(32).optional(),
    memory: z.string().max(500).optional()
  })
  .strict()

export const AGENT_TEMPLATE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'agentTemplates.list',
    params: null,
    handler: (_params, { runtime }) => ({
      templates: agentTemplateRecords(runtime.getAgentTemplateSettings())
    })
  }),
  defineMethod({
    name: 'agentTemplates.set',
    params: SetParams,
    handler: (params, { runtime }) => {
      // Why no await between read and write: another settings write cannot land in between.
      const result = applyAgentTemplateEdit(runtime.getAgentTemplateSettings(), params)
      if (!result.ok) {
        throw new InvalidArgumentError(result.message)
      }
      runtime.replaceAgentTemplateSettings(result.settings)
      return { template: result.template }
    }
  }),
  defineMethod({
    name: 'agentTemplates.remove',
    params: z.object({ id: z.string().min(1).max(64) }).strict(),
    handler: (params, { runtime }) => {
      const result = removeAgentTemplate(runtime.getAgentTemplateSettings(), params.id)
      if (!result.ok) {
        throw new InvalidArgumentError(result.message)
      }
      runtime.replaceAgentTemplateSettings(result.settings)
      return { removed: params.id }
    }
  })
]
