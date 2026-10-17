import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { ConsoleAutoAdvance } from './console-auto-advance'

/**
 * Why a registry and not a direct import of console-auto-advance-registration.ts:
 * the runtime RPC surface (src/main/runtime/rpc/methods/console-auto-advance.ts)
 * has to name the auto-advance runner, but the runner is built from the backoffice
 * console client, which reaches backoffice-auth -> profile-cloud-auth-config /
 * profile-cloud-session-store and with them Electron's `app` and `safeStorage`.
 * The runtime bundle must boot on plain Node (`pnpm run build:orcad`, and the
 * baseline in config/runtime-electron-baseline.txt is empty and may only shrink),
 * so the runtime depends on this leaf and Electron's main process installs the
 * real source at startup. Same shape as the local PTY provider registry.
 *
 * A host with no installed source is not broken: it simply cannot start console
 * local jobs, and callers refuse in the open instead of crashing at require time.
 */
export type ConsoleAutoAdvanceRunnerSource = (runtime: OrcaRuntimeService) => ConsoleAutoAdvance

let source: ConsoleAutoAdvanceRunnerSource | null = null

export function installConsoleAutoAdvanceRunnerSource(next: ConsoleAutoAdvanceRunnerSource): void {
  source = next
}

/** Tests and host teardown only; a headless runtime never installs a source to begin with. */
export function clearConsoleAutoAdvanceRunnerSource(): void {
  source = null
}

/** `null` means this host has no console session that could start a local job. */
export function resolveConsoleAutoAdvanceRunner(
  runtime: OrcaRuntimeService
): ConsoleAutoAdvance | null {
  return source ? source(runtime) : null
}
