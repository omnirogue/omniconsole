import type { CodexInstallationDiagnostics } from '../../../../shared/codex-installation-diagnostics-types'

/** The host's view of the Codex launch binary; rejects on hosts without the probe (web client, older main). */
export function readCodexInstallation(): Promise<CodexInstallationDiagnostics> {
  const describe = window.api?.codexAccounts?.describeInstallation
  if (typeof describe !== 'function') {
    return Promise.reject(new Error('codex installation diagnostics unavailable'))
  }
  return describe()
}
