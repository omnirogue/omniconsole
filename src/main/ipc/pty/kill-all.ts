import { getNativeLocalPtyProvider } from './provider/registry'

/**
 * Kill in-process local PTYs. Daemon-backed PTYs are preserved by daemon disconnect.
 */
export function killAllPty(): void {
  getNativeLocalPtyProvider().killAll()
}
