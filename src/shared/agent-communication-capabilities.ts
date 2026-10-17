import { z } from 'zod'

// The hub's pending answer and OmniRogue's release manifest carry the agent-communication v1
// capability document under `communication`. The pinned contract (./contracts/) is the only
// source of these rules; this parser is proven against every one of its shared fixtures.
export const AGENT_COMMUNICATION_CHANNEL_KINDS = [
  'human_chat',
  'agent_exchange',
  'managed_job'
] as const
export type AgentCommunicationChannelKind = (typeof AGENT_COMMUNICATION_CHANNEL_KINDS)[number]

const channelSchema = z.strictObject({
  kind: z.enum(AGENT_COMMUNICATION_CHANNEL_KINDS),
  implementation: z.enum(['implemented', 'not_implemented', 'unknown']),
  feature_enabled: z.boolean().nullable(),
  receive_mode: z.enum(['none', 'explicit_pull', 'cursor_poll', 'managed_resume']),
  wake_mode: z.enum(['none', 'native_prompt', 'managed_resume']),
  lease_ack: z.boolean(),
  model_ack: z.boolean(),
  reply_correlation: z.boolean(),
  task_incorporation: z.boolean()
})

const documentSchema = z.strictObject({
  schema_version: z.literal(1),
  scope: z.literal('deployment_capabilities'),
  channels: z.array(channelSchema).length(AGENT_COMMUNICATION_CHANNEL_KINDS.length)
})

export type AgentCommunicationChannel = Readonly<z.infer<typeof channelSchema>>

/**
 * `valid` describes what the deployment's code advertises per channel; it never establishes a
 * session's readiness, a delivery or a model's receipt. `unknown` grants no capability at all.
 */
export type AgentCommunicationCapabilities =
  | {
      readonly status: 'valid'
      readonly channels: Readonly<Record<AgentCommunicationChannelKind, AgentCommunicationChannel>>
    }
  | { readonly status: 'unknown' }

const UNKNOWN: AgentCommunicationCapabilities = Object.freeze({ status: 'unknown' })

function claimsNothing(channel: AgentCommunicationChannel): boolean {
  return (
    channel.receive_mode === 'none' &&
    channel.wake_mode === 'none' &&
    !channel.lease_ack &&
    !channel.model_ack &&
    !channel.reply_correlation &&
    !channel.task_incorporation
  )
}

export function parseAgentCommunicationCapabilities(
  value: unknown
): AgentCommunicationCapabilities {
  const parsed = documentSchema.safeParse(value)
  if (!parsed.success) {
    return UNKNOWN
  }
  const channels: Partial<Record<AgentCommunicationChannelKind, AgentCommunicationChannel>> = {}
  for (const channel of parsed.data.channels) {
    // Why: a channel whose code is not implemented (or unknown) that still claims a mode or an
    // acknowledgment contradicts itself, and the contract voids the whole document for it.
    if (
      channels[channel.kind] ||
      (channel.implementation !== 'implemented' && !claimsNothing(channel))
    ) {
      return UNKNOWN
    }
    channels[channel.kind] = Object.freeze({ ...channel })
  }
  // Three entries, three distinct kinds from a three-value enum: every kind is present once.
  return Object.freeze({
    status: 'valid',
    channels: Object.freeze(
      channels as Record<AgentCommunicationChannelKind, AgentCommunicationChannel>
    )
  })
}

/** Reads the `communication` property of a hub pending answer; anything else is unknown. */
export function readAgentCommunicationCapabilities(
  response: unknown
): AgentCommunicationCapabilities {
  if (typeof response !== 'object' || response === null || !('communication' in response)) {
    return UNKNOWN
  }
  return parseAgentCommunicationCapabilities((response as { communication: unknown }).communication)
}
