import type { SessionHostRelocationProvider } from '../../shared/session-host-capabilities'
import { execLocalPreflightCommandOrThrow } from '../ipc/preflight-command-exec'

/** The provider CLI's version on this computer, as its own `--version` reports it. */
export async function localProviderVersion(
  provider: SessionHostRelocationProvider
): Promise<string | null> {
  try {
    const { stdout } = await execLocalPreflightCommandOrThrow(provider, ['--version'])
    return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null
  } catch {
    return null
  }
}
