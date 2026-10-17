import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readWorkflowGeminiKey } from '../../../shared/workflow-gemini-command'

const home = homedir()
const CREDENTIAL_VAULT = home ? join(home, '.config', 'omni', 'connections.env') : undefined
const VAULT_MAX_BYTES = 1024 * 1024

export const WORKFLOW_GEMINI_KEY_MISSING =
  'Gemini needs GEMINI_API_KEY in the environment, ~/.gemini/.env or ~/.config/omni/connections.env.'
/** Windows has no POSIX modes to prove the vault private, so the vault is never read there. */
export const WORKFLOW_GEMINI_KEY_MISSING_WINDOWS =
  'Gemini needs GEMINI_API_KEY in the environment or ~/.gemini/.env.'

export type WorkflowGeminiKeyLookup = { key: string } | { missing: string }

/** The vault's text, read through one descriptor proven to be this user's private regular file. */
export function readPrivateVault(path: string): { text: string } | { refused: string } | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    // Only an absent vault is silence: one that is there but will not open says why.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return undefined
    }
    return { refused: code === 'ELOOP' ? 'is a symbolic link' : `cannot be opened (${code})` }
  }
  try {
    const stat = fstatSync(fd)
    const uid = process.getuid?.()
    if (!stat.isFile() || stat.size > VAULT_MAX_BYTES) {
      return { refused: 'is not a regular file under 1 MB' }
    }
    if ((stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
      return { refused: 'is not private to you (it should be yours, mode 600)' }
    }
    return { text: readFileSync(fd, 'utf8') }
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/**
 * The Gemini key a workflow seat runs with: the process environment, then the account's
 * `.env`, then the credential vault, read only while it is private to this user (the app never
 * sees a login shell's exports). When there is none, why, in words a person can act on.
 */
export function workflowGeminiKeyLookup(
  geminiHome: string,
  environment: NodeJS.ProcessEnv = process.env,
  vaultPath: string | undefined = CREDENTIAL_VAULT,
  platform: NodeJS.Platform = process.platform
): WorkflowGeminiKeyLookup {
  const ambient = environment.GEMINI_API_KEY?.trim()
  if (ambient) {
    return { key: ambient }
  }
  try {
    const own = readWorkflowGeminiKey(readFileSync(join(geminiHome, '.env'), 'utf8'))
    if (own) {
      return { key: own }
    }
  } catch {
    /* No account .env: the vault may still hold the key. */
  }
  if (platform === 'win32' || !vaultPath) {
    return { missing: WORKFLOW_GEMINI_KEY_MISSING_WINDOWS }
  }
  const vault = readPrivateVault(vaultPath)
  if (vault && 'refused' in vault) {
    return {
      missing: `Gemini needs GEMINI_API_KEY in the environment or ~/.gemini/.env; ~/.config/omni/connections.env ${vault.refused}, so it is not read.`
    }
  }
  let key: string | undefined
  try {
    key = vault ? readWorkflowGeminiKey(vault.text) : undefined
  } catch {
    key = undefined
  }
  return key ? { key } : { missing: WORKFLOW_GEMINI_KEY_MISSING }
}

export function workflowGeminiApiKey(
  ...args: Parameters<typeof workflowGeminiKeyLookup>
): string | undefined {
  const lookup = workflowGeminiKeyLookup(...args)
  return 'key' in lookup ? lookup.key : undefined
}
