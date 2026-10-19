import {
  consoleWorkflowCredentialVariants,
  redactConsoleWorkflowValue
} from './console-workflow-redaction'

/** Why a leaf module rather than console-workflow-person.ts: the observed bearers
 *  must stay in main, but the runtime RPC graph reaches this redaction through
 *  console-worker-start-gate.ts, and importing console-workflow-person.ts there
 *  pulled backoffice-auth -> profile-cloud-auth-config / profile-cloud-session-store,
 *  and with them Electron, into the runtime bundle. The runtime-electron baseline
 *  (config/scripts/check-runtime-electron-ratchet.mjs) may only shrink, so the
 *  credential memory lives here, where nothing reaches a host API. */
const credentials = new Map<string, string[]>()

export function rememberConsoleWorkflowCredential(bearer: string): void {
  if (!credentials.has(bearer)) {
    credentials.set(bearer, consoleWorkflowCredentialVariants(bearer))
  }
}

/** Captured credentials stay only in memory, including earlier sessions whose output may arrive late. */
export function redactConsoleWorkflowMemory(value: unknown, keepSignInLinks = false): unknown {
  let safe: unknown = redactConsoleWorkflowValue(value, null, keepSignInLinks)
  let serialized = JSON.stringify(safe)
  for (const [bearer, variants] of credentials) {
    // Why: a full redaction pass per remembered credential made every request cost grow with uptime (#857);
    // the pass is idempotent, so one that cannot match changes nothing and is skipped.
    if (!variants.some((variant) => serialized.includes(variant))) {
      continue
    }
    safe = redactConsoleWorkflowValue(safe, bearer, keepSignInLinks)
    serialized = JSON.stringify(safe)
  }
  return safe
}

export const _internals = {
  forgetConsoleWorkflowCredentials(): void {
    credentials.clear()
  }
}
