// Bounded-shape guards for the two launch inputs a record carries.
//
// Lifted out of agent-session-record.ts so that file stays inside its line budget.
// Neither is part of the record's identity — they describe what a launch was handed,
// which is why the record predicate only calls them rather than defining them.

// Type-only, so no runtime cycle with the record module that calls these.
import type { AgentSessionLaunchArgs, AgentSessionLaunchEnv } from './agent-session-record'

const MAX_LAUNCH_ENV_ENTRIES = 256
const MAX_LAUNCH_ENV_VALUE_LENGTH = 65_536
const MAX_LAUNCH_ARGS = 256
const MAX_LAUNCH_ARGS_BYTES = 16 * 1024
const MAX_ID_LENGTH = 512

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

export function isAgentSessionLaunchEnv(value: unknown): value is AgentSessionLaunchEnv {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_LAUNCH_ENV_ENTRIES &&
    entries.every(
      ([key, entry]) =>
        isBoundedString(key, MAX_ID_LENGTH) &&
        typeof entry === 'string' &&
        entry.length <= MAX_LAUNCH_ENV_VALUE_LENGTH
    )
  )
}

export function isAgentSessionLaunchArgs(value: unknown): value is AgentSessionLaunchArgs {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LAUNCH_ARGS &&
    value.every((arg) => typeof arg === 'string' && !arg.includes('\0')) &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_LAUNCH_ARGS_BYTES
  )
}
