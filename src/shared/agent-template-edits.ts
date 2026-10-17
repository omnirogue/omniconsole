import {
  AGENT_TEMPLATE_DEFAULT_ID,
  MAX_AGENT_TEMPLATE_INSTRUCTIONS_LENGTH,
  MAX_CUSTOM_AGENT_TEMPLATES,
  agentTemplateDigest,
  isBuiltinAgentTemplateId,
  isValidAgentTemplateId,
  normalizeAgentTemplateSettings,
  resolveAgentTemplates,
  type AgentTemplate,
  type AgentTemplateSettings
} from './agent-templates'

/**
 * Edits `omni agents` makes to the stored templates. Each one validates and refuses instead of
 * letting normalization silently truncate or drop what the caller asked for.
 */

const MAX_NAME_LENGTH = 80
const MAX_DESCRIPTION_LENGTH = 200

export type AgentTemplateRecord = AgentTemplate & { digest: string }

export type AgentTemplateEdit = {
  id: string
  name?: string
  description?: string
  instructions: string
}

export type AgentTemplateEditResult =
  | { ok: true; settings: AgentTemplateSettings; template: AgentTemplateRecord }
  | { ok: false; message: string }

export function agentTemplateRecord(template: AgentTemplate): AgentTemplateRecord {
  return { ...template, digest: agentTemplateDigest(template.instructions) }
}

/** Built-ins with their overrides applied, then custom templates in stored order. */
export function agentTemplateRecords(
  settings: AgentTemplateSettings | undefined
): AgentTemplateRecord[] {
  return resolveAgentTemplates(settings).map(agentTemplateRecord)
}

function refuse(message: string): { ok: false; message: string } {
  return { ok: false, message }
}

function checkId(id: string): string | null {
  if (!isValidAgentTemplateId(id)) {
    return `"${id}" is not a template id: use lowercase letters, digits and hyphens (up to 64), starting with a letter or digit.`
  }
  if (id === AGENT_TEMPLATE_DEFAULT_ID) {
    return 'The Default template adds nothing and cannot be edited or removed.'
  }
  return null
}

function checkText(
  label: string,
  value: string | undefined,
  max: number
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, value: undefined }
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return refuse(`${label} cannot be empty.`)
  }
  if (trimmed.length > max) {
    return refuse(`${label} is ${trimmed.length} characters; the limit is ${max}.`)
  }
  return { ok: true, value: trimmed }
}

export function applyAgentTemplateEdit(
  stored: AgentTemplateSettings | undefined,
  edit: AgentTemplateEdit
): AgentTemplateEditResult {
  const idError = checkId(edit.id)
  if (idError) {
    return refuse(idError)
  }
  const instructions = checkText(
    'Instructions',
    edit.instructions.replace(/\r\n/g, '\n'),
    MAX_AGENT_TEMPLATE_INSTRUCTIONS_LENGTH
  )
  const name = checkText('Name', edit.name, MAX_NAME_LENGTH)
  const description = checkText('Description', edit.description, MAX_DESCRIPTION_LENGTH)
  if (!instructions.ok) {
    return instructions
  }
  if (!name.ok) {
    return name
  }
  if (!description.ok) {
    return description
  }
  const text = instructions.value ?? ''
  const newName = name.value
  const newDescription = description.value
  const current = normalizeAgentTemplateSettings(stored)
  let next: AgentTemplateSettings
  if (isBuiltinAgentTemplateId(edit.id, current.custom)) {
    if (newName !== undefined) {
      return refuse('Built-in template names cannot be changed; omit --name.')
    }
    const override = current.overrides?.[edit.id] ?? {}
    next = {
      ...current,
      overrides: {
        ...current.overrides,
        [edit.id]: {
          ...override,
          instructions: text,
          ...(newDescription !== undefined ? { description: newDescription } : {})
        }
      }
    }
  } else {
    const custom = current.custom ?? []
    const existing = custom.find((entry) => entry.id === edit.id)
    if (!existing && newName === undefined) {
      return refuse(`No template "${edit.id}" exists; pass --name to create it.`)
    }
    if (!existing && custom.length >= MAX_CUSTOM_AGENT_TEMPLATES) {
      return refuse(
        `There are already ${MAX_CUSTOM_AGENT_TEMPLATES} custom templates; remove one first.`
      )
    }
    const updated = {
      ...(existing ?? { id: edit.id, name: newName!, description: '' }),
      ...(newName !== undefined ? { name: newName } : {}),
      ...(newDescription !== undefined ? { description: newDescription } : {}),
      instructions: text
    }
    next = {
      ...current,
      custom: existing
        ? custom.map((entry) => (entry.id === edit.id ? updated : entry))
        : [...custom, updated]
    }
  }
  const settings = normalizeAgentTemplateSettings(next)
  const template = resolveAgentTemplates(settings).find((entry) => entry.id === edit.id)
  // Why: normalization drops what it cannot store; a write that did not take must not report success.
  if (!template || template.instructions !== text) {
    return refuse(`The template "${edit.id}" could not be stored.`)
  }
  return { ok: true, settings, template: agentTemplateRecord(template) }
}

export function removeAgentTemplate(
  stored: AgentTemplateSettings | undefined,
  id: string
): { ok: true; settings: AgentTemplateSettings } | { ok: false; message: string } {
  const idError = checkId(id)
  if (idError) {
    return refuse(idError)
  }
  const current = normalizeAgentTemplateSettings(stored)
  if (isBuiltinAgentTemplateId(id, current.custom)) {
    return refuse(`"${id}" is built in; only custom templates can be removed.`)
  }
  const custom = current.custom ?? []
  if (!custom.some((entry) => entry.id === id)) {
    return refuse(`No custom template "${id}" exists.`)
  }
  return {
    ok: true,
    settings: normalizeAgentTemplateSettings({
      ...current,
      custom: custom.filter((entry) => entry.id !== id)
    })
  }
}
