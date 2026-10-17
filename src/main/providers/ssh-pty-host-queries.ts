import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { IPtyProvider } from './types'
import type { PtyProcessInspection } from './pty-process-inspection'

type SshPtyHostQueries = Pick<
  IPtyProvider,
  | 'getCwd'
  | 'getInitialCwd'
  | 'hasChildProcesses'
  | 'getForegroundProcess'
  | 'getDefaultShell'
  | 'getProfiles'
> & { inspectProcess: (id: string) => Promise<PtyProcessInspection> }

export function createSshPtyHostQueries(
  mux: SshChannelMultiplexer,
  toRelayPtyId: (id: string) => string
): SshPtyHostQueries {
  return {
    async getCwd(id) {
      return (await mux.request('pty.getCwd', { id: toRelayPtyId(id) })) as string
    },
    async getInitialCwd(id) {
      return (await mux.request('pty.getInitialCwd', { id: toRelayPtyId(id) })) as string
    },
    async hasChildProcesses(id) {
      return (await mux.request('pty.hasChildProcesses', { id: toRelayPtyId(id) })) as boolean
    },
    async getForegroundProcess(id) {
      return (await mux.request('pty.getForegroundProcess', { id: toRelayPtyId(id) })) as
        | string
        | null
    },
    async getDefaultShell() {
      return (await mux.request('pty.getDefaultShell')) as string
    },
    async getProfiles() {
      return (await mux.request('pty.getProfiles')) as { name: string; path: string }[]
    },
    async inspectProcess(id) {
      return (await mux.request('pty.inspectProcess', {
        id: toRelayPtyId(id)
      })) as PtyProcessInspection
    }
  }
}
