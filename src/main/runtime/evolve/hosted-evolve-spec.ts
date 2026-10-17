import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  EVOLVE_DEFAULT_CHECKOUT,
  evolveSpecPath,
  type EvolveStartRequest
} from '../../../shared/evolve-workflow'
import { isPlainRecord } from './hosted-evolve-schemas'

// omnisi-evolve-service refuses a canonical spec above 256 KiB.
const MAX_SPEC_BYTES = 256 * 1024

export type HostedEvolveSpecDeps = {
  /** Reads the spec file for a hosted submit; defaults to this computer's file system. */
  readSpecFile?: (path: string) => Promise<string>
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The spec at the request's path inside its checkout on this computer, as a JSON object. */
export async function readHostedEvolveSpec(
  request: EvolveStartRequest,
  deps?: HostedEvolveSpecDeps
): Promise<Record<string, unknown>> {
  const checkout = request.checkout ?? EVOLVE_DEFAULT_CHECKOUT
  const root = checkout.startsWith('~/') ? join(homedir(), checkout.slice(2)) : checkout
  const specPath = evolveSpecPath(request)
  const file = resolve(root, specPath)
  const read = deps?.readSpecFile ?? ((path: string) => readFile(path, 'utf8'))
  let raw: string
  try {
    raw = await read(file)
  } catch (error) {
    throw new Error(`Could not read the Evolve spec ${specPath} in ${checkout}: ${reason(error)}`)
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_SPEC_BYTES) {
    throw new Error(`The Evolve spec ${specPath} is larger than ${MAX_SPEC_BYTES / 1024} KiB.`)
  }
  let parsed: unknown
  try {
    // JSON is valid YAML, so one parser reads both spec formats.
    parsed = parseYaml(raw)
  } catch (error) {
    throw new Error(`The Evolve spec ${specPath} is not valid JSON or YAML: ${reason(error)}`)
  }
  if (!isPlainRecord(parsed)) {
    throw new Error(`The Evolve spec ${specPath} must be a JSON object.`)
  }
  return parsed
}

/**
 * The run's hold in cents as the service admits it (`budget.max_cost_cents` before `usd_cap`):
 * a larger spec budget is lowered to the person's cap so the cap always binds.
 */
export function capHostedEvolveSpend(
  spec: Record<string, unknown>,
  usdCap?: number
): number | undefined {
  const capCents = usdCap ? Math.ceil(usdCap * 100) : undefined
  const budget = isPlainRecord(spec.budget) ? spec.budget : undefined
  const raw = budget?.max_cost_cents
  const specCents = typeof raw === 'number' && Number.isInteger(raw) ? raw : undefined
  if (budget && capCents !== undefined && specCents !== undefined && specCents > capCents) {
    budget.max_cost_cents = capCents
    return capCents
  }
  return specCents ?? capCents
}
