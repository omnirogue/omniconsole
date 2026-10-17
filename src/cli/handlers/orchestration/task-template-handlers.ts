import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CommandHandler } from '../../dispatch'
import { getOptionalStringFlag, getRepeatedStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import {
  ORCHESTRATION_TASK_TEMPLATE_IDS,
  ORCHESTRATION_TASK_TEMPLATE_VERSION,
  getOrchestrationTaskTemplate,
  isOrchestrationTaskTemplateId,
  listOrchestrationTaskTemplates,
  renderOrchestrationTaskTemplate,
  type OrchestrationTaskTemplate,
  type OrchestrationTaskTemplateId
} from '../../../shared/orchestration-task-templates'

const MAX_FIELDS_FILE_BYTES = 256 * 1024

export type TemplatedTaskSpec = {
  template: OrchestrationTaskTemplateId
  spec: string
  title: string
  reviewTriggers: string[]
  /** The fields it was rendered from, so a dependent verify task checks the same Acceptance. */
  values: Record<string, string>
}

function requireTemplateId(value: string): OrchestrationTaskTemplateId {
  if (!isOrchestrationTaskTemplateId(value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown task template "${value}". Available: ${ORCHESTRATION_TASK_TEMPLATE_IDS.join(', ')}.`
    )
  }
  return value
}

async function readFieldsFile(path: string): Promise<Record<string, string>> {
  let parsed: unknown
  try {
    if ((await stat(path)).size > MAX_FIELDS_FILE_BYTES) {
      throw new Error(`it is larger than ${MAX_FIELDS_FILE_BYTES} bytes`)
    }
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--fields-file: could not read ${path}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RuntimeClientError('invalid_argument', '--fields-file must hold one JSON object.')
  }
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new RuntimeClientError('invalid_argument', `--fields-file: "${key}" must be a string.`)
    }
    fields[key] = value
  }
  return fields
}

function parseFieldFlags(entries: string[]): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const entry of entries) {
    const at = entry.indexOf('=')
    if (at <= 0) {
      throw new RuntimeClientError('invalid_argument', `--field expects key=value, got "${entry}".`)
    }
    fields[entry.slice(0, at).trim()] = entry.slice(at + 1)
  }
  return fields
}

/** The spec a `--template` call renders, or null when the caller passed a plain `--spec`. */
export async function resolveTemplatedTaskSpec(
  flags: Map<string, string | boolean>,
  cwd: string
): Promise<TemplatedTaskSpec | null> {
  const templateFlag = getOptionalStringFlag(flags, 'template')
  const fieldFlags = getRepeatedStringFlag(flags, 'field')
  const fieldsFile = getOptionalStringFlag(flags, 'fields-file')
  if (!templateFlag) {
    if (fieldFlags.length > 0 || fieldsFile || flags.has('print-spec')) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--field, --fields-file and --print-spec need --template <id>.'
      )
    }
    return null
  }
  if (flags.has('spec')) {
    throw new RuntimeClientError('invalid_argument', 'Give --spec or --template, not both.')
  }
  const template = requireTemplateId(templateFlag)
  // Why: flags win over the file so one field can be corrected without rewriting the file.
  const values = {
    ...(fieldsFile ? await readFieldsFile(resolve(cwd, fieldsFile)) : {}),
    ...parseFieldFlags(fieldFlags)
  }
  const rendered = renderOrchestrationTaskTemplate(template, values)
  if (!rendered.ok) {
    throw new RuntimeClientError(
      'invalid_argument',
      `The ${template} template is incomplete; no task was created.\n${rendered.problems
        .map((problem) => `- ${problem.field}: ${problem.detail}`)
        .join('\n')}\nSee: omni orchestration task-templates --template ${template}`
    )
  }
  return {
    template,
    spec: rendered.spec,
    title: rendered.title,
    reviewTriggers: rendered.reviewTriggers,
    values
  }
}

/**
 * The verify task an implement task gets by default: the same Acceptance, re-run read-only by a
 * worker who did not write it. Null for other templates; `--no-verify` skips it.
 */
export function dependentVerifyTaskSpec(
  templated: TemplatedTaskSpec | null,
  implementTaskId: string
): TemplatedTaskSpec | null {
  if (templated?.template !== 'implement') {
    return null
  }
  const values = {
    ...templated.values,
    objective: `Verify: ${templated.values.objective ?? ''}`.trim(),
    verifyOf: `Task ${implementTaskId} (${templated.title})`
  }
  const rendered = renderOrchestrationTaskTemplate('verify', values)
  return rendered.ok
    ? {
        template: 'verify',
        spec: rendered.spec,
        title: rendered.title,
        reviewTriggers: [],
        values
      }
    : null
}

export function reviewTriggerNote(templated: TemplatedTaskSpec | null): string {
  return templated && templated.reviewTriggers.length > 0
    ? `\nThis brief touches ${templated.reviewTriggers.join(', ')}: add an independent-review task before QA.`
    : ''
}

function describeTemplate(template: OrchestrationTaskTemplate): string {
  const fields = template.fields
    .map((entry) => `  ${entry.key}${entry.required ? '' : ' (optional)'}: ${entry.description}`)
    .join('\n')
  const rules = template.rules.map((rule) => `  - ${rule}`).join('\n')
  return `${template.id}@${ORCHESTRATION_TASK_TEMPLATE_VERSION}: ${template.summary}\nFields:\n${fields}\nStage rules:\n${rules}`
}

export const ORCHESTRATION_TASK_TEMPLATE_HANDLERS: Record<string, CommandHandler> = {
  'orchestration task-templates': async ({ flags, json }) => {
    const only = getOptionalStringFlag(flags, 'template')
    const templates = only
      ? [getOrchestrationTaskTemplate(requireTemplateId(only))]
      : listOrchestrationTaskTemplates()
    console.log(
      json
        ? JSON.stringify({ version: ORCHESTRATION_TASK_TEMPLATE_VERSION, templates }, null, 2)
        : only
          ? describeTemplate(templates[0]!)
          : templates.map((template) => `${template.id}: ${template.summary}`).join('\n')
    )
  }
}
