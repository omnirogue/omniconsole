/** Diagnostic failures must not alter execution or expose request/error text. */
export function warnLaunchProvenanceFailure(scope: string): void {
  try {
    console.warn(`[launch-ledger] ${scope}: provenance unavailable`)
  } catch {
    // Even the diagnostic sink may be unavailable.
  }
}

export function attemptLaunchProvenance<T>(scope: string, run: () => T, fallback: T): T {
  try {
    return run()
  } catch {
    warnLaunchProvenanceFailure(scope)
    return fallback
  }
}
