import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const credentialPatterns = {
  OPENROUTER_API_KEY: /^[A-Za-z0-9_-]{16,512}$/,
  TYPESAFE_API_KEY: /^[A-Za-z0-9_-]{16,512}$/,
  ACME_META_ACCESS_TOKEN: /^[A-Za-z0-9_-]{16,4096}$/,
  // An OmniSI API key with budget scopes: osi_api1.<org>.<secret>
  OMNISI_AGENT_BUDGET_KEY: /^osi_api1\.[A-Za-z0-9_.:-]{16,600}$/
} as const

async function resolveLiteralCredential(
  name: keyof typeof credentialPatterns,
  environment: NodeJS.ProcessEnv,
  vaultPath: string
): Promise<string | undefined> {
  const credentialPattern = credentialPatterns[name]
  const explicit = environment[name]?.trim()
  if (explicit) {
    return credentialPattern.test(explicit) ? explicit : undefined
  }
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(vaultPath, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      return undefined
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      return undefined
    }
    const buffer = Buffer.alloc(1024 * 1024 + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 1024 * 1024 || bytesRead < stat.size) {
      return undefined
    }
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const assignment = new RegExp(`^(?:export\\s+)?${name}\\s*=`)
    const entries = text.split(/\r?\n/).filter((line) => assignment.test(line))
    if (entries.length !== 1) {
      return undefined
    }
    const raw = entries[0].replace(assignment, '').trim()
    const value = /^(['"])(.*)\1$/.exec(raw)?.[2] ?? raw
    return credentialPattern.test(value) ? value : undefined
  } catch {
    return undefined
  } finally {
    await file?.close().catch(() => undefined)
  }
}

/** Fixed main-only credential names; neither a name nor a vault path comes from RPC. */
export function resolveTypesafeCredential(
  environment: NodeJS.ProcessEnv = process.env,
  vaultPath = join(homedir(), '.config', 'omni', 'connections.env')
): Promise<string | undefined> {
  return resolveLiteralCredential('TYPESAFE_API_KEY', environment, vaultPath)
}

export function resolveAcmeMetaCredential(
  environment: NodeJS.ProcessEnv = process.env,
  vaultPath = join(homedir(), '.config', 'omni', 'connections.env')
): Promise<string | undefined> {
  return resolveLiteralCredential('ACME_META_ACCESS_TOKEN', environment, vaultPath)
}

export function resolveAgentBudgetCredential(
  environment: NodeJS.ProcessEnv = process.env,
  vaultPath = join(homedir(), '.config', 'omni', 'connections.env')
): Promise<string | undefined> {
  return resolveLiteralCredential('OMNISI_AGENT_BUDGET_KEY', environment, vaultPath)
}

export function resolveOpenRouterCredential(
  environment: NodeJS.ProcessEnv = process.env,
  vaultPath = join(homedir(), '.config', 'omni', 'connections.env')
): Promise<string | undefined> {
  return resolveLiteralCredential('OPENROUTER_API_KEY', environment, vaultPath)
}
