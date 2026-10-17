import type { NamedQuitTeardown } from '../quit-teardown-deadline'

/** Admission is already fenced; slow outcome work must not hold legacy cleanup behind it. */
export function beginOutcomeQuitTeardowns(options: {
  suspension: Promise<unknown>
  beginSshShutdown: () => Promise<unknown> | void
  flushState: () => Promise<unknown> | void
  killNativePty: () => Promise<unknown> | void
  disconnectDaemon: () => Promise<unknown> | void
}): NamedQuitTeardown[] {
  // Capture synchronous SSH detachment and native PTY cleanup before any await.
  const ssh = options.beginSshShutdown()
  const nativePty = options.killNativePty()
  const state = options.flushState()
  const daemon = options.disconnectDaemon()
  return [
    { name: 'outcome-continuation', promise: options.suspension },
    { name: 'ssh', promise: Promise.resolve(ssh) },
    { name: 'state', promise: Promise.resolve(state) },
    { name: 'native-pty', promise: Promise.resolve(nativePty) },
    { name: 'daemon', promise: Promise.resolve(daemon) }
  ]
}
