import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { z } from 'zod'
import {
  DECISION_MAX_TIMEOUT_MS,
  decisionIdentifierSchema,
  type DecisionMode
} from '../../shared/structured-decisions'

export const DECISION_KILL_ENV = 'OMNI_STRUCTURED_DECISIONS_KILL'
const modeSchema = z.object({ mode: z.enum(['off', 'shadow', 'live']) }).strict()
export const decisionConfigurationSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    killSwitch: z.boolean().default(false),
    model: decisionIdentifierSchema.optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(DECISION_MAX_TIMEOUT_MS)
      .default(DECISION_MAX_TIMEOUT_MS),
    capabilities: z.record(decisionIdentifierSchema, modeSchema),
    routines: z.record(decisionIdentifierSchema, modeSchema).default({})
  })
  .strict()
export type DecisionConfiguration = z.infer<typeof decisionConfigurationSchema> & { valid: boolean }
export type DecisionConfigurationSource = () =>
  | DecisionConfiguration
  | Promise<DecisionConfiguration>
export type DecisionRoutineModeSource = (routineId: string) => DecisionMode | Promise<DecisionMode>

export function decisionEnvironmentKilled(
  environment: Record<string, string | undefined>
): boolean {
  const kill = environment[DECISION_KILL_ENV]
  return kill !== undefined && kill !== '' && !['0', 'false'].includes(kill.toLowerCase())
}

export function disabledDecisionConfiguration(): DecisionConfiguration {
  return {
    version: 1,
    valid: false,
    enabled: false,
    killSwitch: true,
    timeoutMs: DECISION_MAX_TIMEOUT_MS,
    capabilities: {},
    routines: {}
  }
}

export function parseDecisionConfiguration(input: unknown): DecisionConfiguration {
  const parsed = decisionConfigurationSchema.safeParse(input)
  return parsed.success ? { ...parsed.data, valid: true } : disabledDecisionConfiguration()
}

export async function readBoundedConfiguration(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const maxBytes = 32 * 1024
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new Error('configuration_not_regular_file')
    }
    if (stat.size > maxBytes) {
      throw new Error('configuration_too_large')
    }
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxBytes) {
      throw new Error('configuration_too_large')
    }
    if (bytesRead < stat.size) {
      throw new Error('configuration_incomplete_read')
    }
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export function createDecisionConfigurationReader(
  path: string,
  options: {
    environment?: () => Record<string, string | undefined>
    readText?: () => Promise<string>
  } = {}
): DecisionConfigurationSource {
  return async () => {
    try {
      if (decisionEnvironmentKilled(options.environment?.() ?? process.env)) {
        return disabledDecisionConfiguration()
      }
      const text = await (options.readText?.() ?? readBoundedConfiguration(path))
      if (decisionEnvironmentKilled(options.environment?.() ?? process.env)) {
        return disabledDecisionConfiguration()
      }
      if (Buffer.byteLength(text, 'utf8') > 32 * 1024) {
        return disabledDecisionConfiguration()
      }
      return parseDecisionConfiguration(JSON.parse(text))
    } catch {
      return disabledDecisionConfiguration()
    }
  }
}
