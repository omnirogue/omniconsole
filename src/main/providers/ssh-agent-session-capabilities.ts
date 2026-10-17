import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { proveSshAgentSessionClaimCapability } from './ssh-agent-session-claim-validation'
import {
  SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
  sshSupportsAgentSessionCreateOperations
} from './ssh-agent-session-create-operation'
import { waitForSshCapabilityProbe } from './ssh-capability-probe-waiter'

export class SshAgentSessionCapabilities {
  private claimProbe: Promise<void> | null = null
  private claimSupported = false
  private createOperationProbe: Promise<boolean> | null = null
  private omniConsoleMcpProbe: Promise<boolean> | null = null

  constructor(private readonly mux: SshChannelMultiplexer) {}

  async supportsClaims(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe = this.claimProbe ?? proveSshAgentSessionClaimCapability(this.mux)
    this.claimProbe = probe
    try {
      await waitForSshCapabilityProbe(probe, options.signal)
      this.claimSupported = true
      return true
    } catch {
      if (!options.signal?.aborted && this.claimProbe === probe) {
        // Why: negative physical probes must follow a relay upgraded on this connection.
        this.claimProbe = null
        this.claimSupported = false
      }
      return false
    }
  }

  providesOwnerListings(): boolean {
    return this.claimSupported
  }

  async supportsOmniConsoleMcpDefault(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe =
      this.omniConsoleMcpProbe ??
      this.mux
        .request('pty.getCapabilities', undefined, {
          timeoutMs: SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS
        })
        .then(
          (result) =>
            (result as { omniConsoleMcpDefaultVersion?: unknown } | null)
              ?.omniConsoleMcpDefaultVersion === 1,
          () => false
        )
    this.omniConsoleMcpProbe = probe
    let supported: boolean
    try {
      supported = await waitForSshCapabilityProbe(probe, options.signal)
    } catch {
      return false
    }
    if (!supported && this.omniConsoleMcpProbe === probe) {
      // Why: retry after an older relay upgrades on the same connection.
      this.omniConsoleMcpProbe = null
    }
    return supported
  }

  async supportsCreateOperations(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe = this.createOperationProbe ?? sshSupportsAgentSessionCreateOperations(this.mux)
    this.createOperationProbe = probe
    let supported: boolean
    try {
      supported = await waitForSshCapabilityProbe(probe, options.signal)
    } catch {
      // Why: one canceled waiter must not cancel or evict the shared physical probe used by peers.
      return false
    }
    if (!supported && this.createOperationProbe === probe) {
      // Why: negative capability results must follow a relay upgraded on the same connection.
      this.createOperationProbe = null
    }
    return supported
  }
}
