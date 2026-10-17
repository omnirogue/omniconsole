import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AgentTemplateRecord } from '../../shared/agent-template-edits'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

// Why a byte cap above the 20,000-character limit: the host enforces the limit; this only bounds the read.
const MAX_INSTRUCTIONS_FILE_BYTES = 256 * 1024

function templateKind(template: AgentTemplateRecord): string {
  if (!template.builtin) {
    return 'custom'
  }
  return template.edited ? 'built-in, edited' : 'built-in'
}

export function formatAgentTemplateList(value: { templates: AgentTemplateRecord[] }): string {
  return value.templates
    .map((template) =>
      [
        `${template.id}  ${template.name}  (${templateKind(template)})  digest ${template.digest}`,
        template.description ? `  ${template.description}` : null
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n')
}

export function formatAgentTemplate(template: AgentTemplateRecord): string {
  return [
    `${template.name} (${template.id}, ${templateKind(template)})`,
    template.description ? `Description: ${template.description}` : null,
    template.preferredModel ? `Preferred model: ${template.preferredModel}` : null,
    `Digest: ${template.digest}`,
    '',
    template.instructions ?? '(adds nothing)'
  ]
    .filter((line) => line !== null)
    .join('\n')
}

async function readInstructions(
  flags: Map<string, string | boolean>,
  cwd: string
): Promise<string> {
  const inline = flags.get('instructions')
  const file = getOptionalStringFlag(flags, 'instructions-file')
  if ((typeof inline === 'string') === Boolean(file)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass exactly one of --instructions-file <path> or --instructions <text>.'
    )
  }
  if (typeof inline === 'string') {
    return inline
  }
  if (process.env.ORCA_CLI_CWD) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--instructions-file is unavailable through a forwarded SSH/WSL shell; pass --instructions instead.'
    )
  }
  const path = resolve(cwd, file!)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size > MAX_INSTRUCTIONS_FILE_BYTES) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Cannot read --instructions-file ${file}: it must be a regular file under 256 KB.`
    )
  }
  return readFile(path, 'utf8')
}

export const AGENT_TEMPLATE_HANDLERS: Record<string, CommandHandler> = {
  'agents list': async ({ client, json }) => {
    const result = await client.call<{ templates: AgentTemplateRecord[] }>('agentTemplates.list')
    printResult(result, json, formatAgentTemplateList)
  },
  'agents show': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const result = await client.call<{ templates: AgentTemplateRecord[] }>('agentTemplates.list')
    const template = result.result.templates.find((entry) => entry.id === id)
    if (!template) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown agent template "${id}". Run "omni agents list" to see the available ids.`
      )
    }
    printResult({ ...result, result: { template } }, json, (value) =>
      formatAgentTemplate(value.template)
    )
  },
  'agents set': async ({ flags, client, cwd, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const instructions = await readInstructions(flags, cwd)
    const name = getOptionalStringFlag(flags, 'name')
    const description = getOptionalStringFlag(flags, 'description')
    const result = await client.call<{ template: AgentTemplateRecord }>('agentTemplates.set', {
      id,
      instructions,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {})
    })
    printResult(
      result,
      json,
      (value) =>
        `Saved ${value.template.name} (${value.template.id}); digest ${value.template.digest}.`
    )
  },
  'agents rm': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const result = await client.call<{ removed: string }>('agentTemplates.remove', { id })
    printResult(result, json, (value) => `Removed agent template ${value.removed}.`)
  }
}
