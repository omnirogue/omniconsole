/**
 * OpenSSH multiplexing options for short fleet command probes.
 * Why separate from buildSshArgs: that path owns OmniConsole's per-target relay
 * socket; fleet probes share one user-scoped master per route instead.
 */

// Why `cm-%C`: %C hashes local host, remote host, port and user, so routes never
// share a master, and the short form stays under the ~104-byte Unix socket limit.
export const FLEET_SSH_CONTROL_PATH = '~/.ssh/cm-%C'
export const FLEET_SSH_CONTROL_PERSIST_SECONDS = 600

export type FleetSshMultiplexMode =
  | 'multiplexed'
  | 'forwarding-opt-out'
  | 'reuse-disabled'
  | 'unsupported-platform'

export type FleetSshMultiplexRequest = {
  /** Caller's own OpenSSH options (before the destination); scanned for forwarding. */
  sshArgs?: readonly string[]
  /** Mirrors SshTarget.systemSshConnectionReuse: false is the per-target compatibility opt-out. */
  connectionReuse?: boolean
  platform?: NodeJS.Platform
}

export type FleetSshMultiplexPlan = {
  mode: FleetSshMultiplexMode
  args: string[]
  /** Forwarding options that forced the opt-out, for diagnostics. */
  forwardingOptions: string[]
}

export type FleetSshMasterControlCommand = 'check' | 'exit'

// OpenSSH flags that consume a value (from ssh(1) getopt); needed to walk `-fNL 8080:...` clusters.
const SSH_FLAGS_WITH_VALUE = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''))
const SSH_FORWARD_FLAGS = new Set(['L', 'R', 'D'])
const SSH_FORWARD_CONFIG_KEYS = new Set(['localforward', 'remoteforward', 'dynamicforward'])

function isForwardConfigOption(value: string): boolean {
  const key = value.trim().split(/[\s=]/, 1)[0]?.toLowerCase() ?? ''
  return SSH_FORWARD_CONFIG_KEYS.has(key)
}

/**
 * Returns the forwarding options present in `args` (stops at `--`).
 * Why parse clusters: `-fNL 8080:host:80` requests a local forward exactly like `-L`.
 */
export function findFleetSshForwardingOptions(args: readonly string[]): string[] {
  const found: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      break
    }
    if (!arg.startsWith('-') || arg.length < 2) {
      continue
    }
    for (let charIndex = 1; charIndex < arg.length; charIndex += 1) {
      const flag = arg[charIndex]
      if (!SSH_FLAGS_WITH_VALUE.has(flag)) {
        continue
      }
      const inlineValue = arg.slice(charIndex + 1)
      const value = inlineValue.length > 0 ? inlineValue : (args[index + 1] ?? '')
      if (inlineValue.length === 0) {
        index += 1
      }
      if (SSH_FORWARD_FLAGS.has(flag)) {
        found.push(`-${flag} ${value}`.trim())
      } else if (flag === 'o' && isForwardConfigOption(value)) {
        found.push(`-o ${value}`)
      }
      break
    }
  }
  return found
}

/**
 * Plans multiplexing for one fleet probe.
 * Why opt out for forwards: a muxed `-L`/`-R` is registered on the shared master
 * and outlives the client, so the next probe's forward collides on the same port.
 */
export function planFleetSshMultiplex(
  request: FleetSshMultiplexRequest = {}
): FleetSshMultiplexPlan {
  const platform = request.platform ?? process.platform
  const forwardingOptions = findFleetSshForwardingOptions(request.sshArgs ?? [])
  // Why `-S none` on every opt-out: it also overrides a user `Host *` ControlMaster block.
  const optOutArgs = ['-S', 'none']
  if (platform === 'win32') {
    // Why: Win32-OpenSSH has no ControlMaster support; a config-inherited master fails the call.
    return { mode: 'unsupported-platform', args: optOutArgs, forwardingOptions }
  }
  if (request.connectionReuse === false) {
    return { mode: 'reuse-disabled', args: optOutArgs, forwardingOptions }
  }
  if (forwardingOptions.length > 0) {
    return { mode: 'forwarding-opt-out', args: optOutArgs, forwardingOptions }
  }
  return {
    mode: 'multiplexed',
    args: [
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${FLEET_SSH_CONTROL_PATH}`,
      '-o',
      `ControlPersist=${FLEET_SSH_CONTROL_PERSIST_SECONDS}`,
      // Why: a probe that becomes the master must not register the user's config
      // LocalForward/RemoteForward entries on the socket every later probe shares.
      '-o',
      'ClearAllForwardings=yes'
    ],
    forwardingOptions
  }
}

export function buildFleetSshMultiplexArgs(request: FleetSshMultiplexRequest = {}): string[] {
  return planFleetSshMultiplex(request).args
}

/**
 * `ssh -O check|exit` against the fleet master for `destination`.
 * Why: lets a caller drop a master that still holds stale forwards, without killing processes.
 */
export function buildFleetSshMasterControlArgs(
  command: FleetSshMasterControlCommand,
  destination: string,
  platform: NodeJS.Platform = process.platform
): string[] | null {
  if (platform === 'win32' || destination.length === 0 || destination.startsWith('-')) {
    return null
  }
  return ['-o', `ControlPath=${FLEET_SSH_CONTROL_PATH}`, '-O', command, '--', destination]
}
