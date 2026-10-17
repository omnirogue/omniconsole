import { z } from 'zod'
import {
  AGENT_TEMPLATE_DEFAULT_ID,
  agentTemplateDigest,
  resolveAgentTemplates,
  type AgentTemplate,
  type AgentTemplateSettings
} from './agent-templates'

/**
 * Which agent template a session was launched with, recorded on its tab when it starts.
 * `digest` names the text it started with, so a later edit to the template is visible.
 * An explicit Default is recorded too; no record means the launch never said.
 */
export type SessionAgentTemplate = { id: string; name: string; digest: string }

export const sessionAgentTemplateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  digest: z.string().regex(/^[0-9a-f]{12}$/)
})

export function sessionAgentTemplateFor(template: AgentTemplate): SessionAgentTemplate {
  return {
    id: template.id,
    name: template.name,
    digest: agentTemplateDigest(template.instructions)
  }
}

export type SessionAgentTemplateResolution =
  | { ok: true; template: SessionAgentTemplate }
  | { ok: false; message: string }

/** An unknown id is an error, never Default or another template. */
export function resolveSessionAgentTemplate(
  settings: AgentTemplateSettings | undefined,
  id: string
): SessionAgentTemplateResolution {
  const template = resolveAgentTemplates(settings).find((entry) => entry.id === id)
  if (!template) {
    return {
      ok: false,
      message: `Unknown agent template "${id}". Run "omni agents list" to see the available ids.`
    }
  }
  return { ok: true, template: sessionAgentTemplateFor(template) }
}

/** A dispatch picker's choice, where null is Default; an id no longer in settings records nothing. */
export function sessionAgentTemplateForChoice(
  settings: AgentTemplateSettings | undefined,
  id: string | null
): SessionAgentTemplate | undefined {
  const resolved = resolveSessionAgentTemplate(settings, id ?? AGENT_TEMPLATE_DEFAULT_ID)
  return resolved.ok ? resolved.template : undefined
}

export type SessionAgentTemplateView =
  | { state: 'unrecorded' | 'default' }
  | { state: 'current' | 'changed' | 'removed'; id: string; name: string }

/** How Session details reads a recorded template against the templates as they are now. */
export function sessionAgentTemplateView(
  recorded: SessionAgentTemplate | undefined,
  settings: AgentTemplateSettings | undefined
): SessionAgentTemplateView {
  // Why not Default: a launch from before recording, or one that never said, may have had a role.
  if (!recorded) {
    return { state: 'unrecorded' }
  }
  if (recorded.id === AGENT_TEMPLATE_DEFAULT_ID) {
    return { state: 'default' }
  }
  const current = resolveAgentTemplates(settings).find((entry) => entry.id === recorded.id)
  if (!current) {
    return { state: 'removed', id: recorded.id, name: recorded.name }
  }
  return {
    state: agentTemplateDigest(current.instructions) === recorded.digest ? 'current' : 'changed',
    id: current.id,
    name: current.name
  }
}
