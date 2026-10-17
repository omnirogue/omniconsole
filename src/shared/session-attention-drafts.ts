import type { HumanAttentionDraft, HumanAttentionRequest } from './session-human-attention'
import type { SessionAttemptRequirement } from './session-attempt-recovery'

/**
 * The words of every request, in one place: what the person must provide, and why the run cannot
 * continue without them. A writer names the requirement; it never composes its own "needs you".
 */
type Scope = HumanAttentionRequest['scope']
const OWNER = { type: 'owner' } as const

function clip(value: string, max = 2_000): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/** A source ref is an identity, never empty: an unreadable one would refuse the whole request. */
function ref(value: string | undefined, fallback: string): string {
  return clip(value ?? '', 400) || fallback
}

function openConversation(
  paneKey: string | undefined,
  label: string
): HumanAttentionDraft['action'] {
  const pane = paneKey?.trim()
  // Why the length: the action's pane is a label in the schema, and one it cannot hold is left out.
  return {
    kind: 'open-conversation',
    label,
    ...(pane && pane.length <= 200 ? { paneKey: pane } : {})
  }
}

/** The agent itself asked its person a question or for a permission. */
export function agentPromptAttention(input: {
  scope: Scope
  kind: 'permission' | 'clarification'
  agent: string
  prompt: string
  paneKey?: string
}): HumanAttentionDraft {
  const permission = input.kind === 'permission'
  return {
    kind: input.kind,
    scope: input.scope,
    ask: clip(
      permission
        ? `Allow or deny what ${input.agent} is asking to do: ${input.prompt}`
        : `Answer ${input.agent}'s question: ${input.prompt}`
    ),
    why: permission
      ? `${input.agent} stopped at a permission prompt that only you may answer.`
      : `${input.agent} cannot choose this for you and is waiting for your answer.`,
    recipient: OWNER,
    action: openConversation(input.paneKey, permission ? 'Review request' : 'Answer'),
    source: { type: 'agent-prompt', ref: ref(input.prompt, input.kind) }
  }
}

/** The outcome finishes with the owner's own review of this version. */
export function ownReviewAttention(input: {
  scope: Scope & { conditionId: string }
  title: string
  version?: string
}): HumanAttentionDraft {
  return {
    kind: 'review',
    scope: input.scope,
    ask: clip(`Review the result of "${input.title}" and approve it or send it back.`),
    why: 'This outcome is finished only by your own review; nobody else can give it.',
    recipient: OWNER,
    action: { kind: 'review-outcome', label: 'Review', conditionId: input.scope.conditionId },
    source: { type: 'review-condition', ref: ref(input.version, input.scope.conditionId) }
  }
}

/** A named person was asked to review; the run waits on THEM, and it is their request, not the owner's. */
export function personReviewAttention(input: {
  scope: Scope & { conditionId: string }
  title: string
  employeeId: string
  name?: string
}): HumanAttentionDraft {
  return {
    kind: 'review',
    scope: input.scope,
    ask: clip(`Review "${input.title}" and reply with your decision.`),
    why: 'The plan continues only with the reply of the person it was sent to.',
    recipient: {
      type: 'person',
      employeeId: input.employeeId,
      ...(input.name ? { name: input.name } : {})
    },
    source: {
      type: 'review-condition',
      ref: clip(`${input.employeeId}:${input.scope.conditionId}`, 400)
    }
  }
}

/** Reviewers still report findings after every authorized repair round. */
export function reviewFindingsAttention(input: {
  scope: Scope
  rounds: number
  findings: number
}): HumanAttentionDraft {
  return {
    kind: 'decision',
    scope: input.scope,
    ask: clip(
      `Decide what happens to ${input.findings} open review finding${input.findings === 1 ? '' : 's'}: add another repair stage, or finish with the work as it is.`
    ),
    why:
      input.rounds === 1
        ? 'The one authorized review round is used; another one needs your say.'
        : `All ${input.rounds} authorized review rounds are used; another one needs your say.`,
    recipient: OWNER,
    action: { kind: 'open-up-next', label: 'Decide' },
    source: { type: 'review-findings', ref: `rounds:${input.rounds}` }
  }
}

/** A verification gate failed and the plan has no repair route to send the failure to. */
export function verificationGateAttention(input: {
  scope: Scope
  summary: string
}): HumanAttentionDraft {
  return {
    kind: 'decision',
    scope: input.scope,
    ask: clip(
      `Verification did not pass (${input.summary}). Add a stage to fix it, or finish with the work as it is.`
    ),
    why: 'The plan names no repair stage for a failed verification, so choosing one is yours.',
    recipient: OWNER,
    action: { kind: 'open-up-next', label: 'Decide' },
    source: { type: 'verification-gate', ref: ref(input.summary, 'verification') }
  }
}

/**
 * A wait came back as something other than a yes, or its deadline passed: whether to keep waiting,
 * continue anyway or cancel is the owner's call, answered in the conversation or its Waiting list.
 */
export function eventWaitAttention(input: {
  scope: Scope & { conditionId: string }
  person: string
  place: string
  reason?: string
  excerpt?: string
  paneKey?: string
}): HumanAttentionDraft {
  const heard = input.excerpt
    ? `${input.person} replied${input.place ? ` ${input.place}` : ''}: "${clip(input.excerpt, 280)}".`
    : (input.reason ?? `${input.person} did not approve.`)
  return {
    kind: 'decision',
    scope: input.scope,
    ask: clip(`${heard} Keep waiting, continue anyway, or cancel?`),
    why: 'The plan only continues on their approval, so what happens now is your decision.',
    recipient: OWNER,
    action: openConversation(input.paneKey, 'Decide'),
    source: { type: 'review-condition', ref: ref(`wait:${input.scope.conditionId}`, 'wait') }
  }
}

/** The signed company or person this run belongs to is not the one signed in. */
export function principalAttention(scope: Scope): HumanAttentionDraft {
  return {
    kind: 'credential',
    scope,
    ask: 'Sign back in as the company and person this work was started under.',
    why: 'The work is bound to that identity and may not continue under another one.',
    recipient: OWNER,
    action: { kind: 'sign-in', label: 'Sign in' },
    source: { type: 'principal', ref: scope.outcomeId }
  }
}

/** A requirement the recovery ladder found that no retry can meet. */
export function attemptRequirementAttention(input: {
  requirement: SessionAttemptRequirement
  scope: Scope
  agent: string
  detail?: string
  paneKey?: string
}): HumanAttentionDraft {
  const { agent, scope } = input
  switch (input.requirement) {
    case 'provider-authentication':
      return {
        kind: 'credential',
        scope,
        ask: `Sign ${agent} in again.`,
        why: `${agent}'s provider rejected its sign-in, and only you hold those credentials.`,
        recipient: OWNER,
        action: openConversation(input.paneKey, 'Sign in'),
        source: { type: 'provider-authentication', ref: agent }
      }
    case 'provider-usage-limit':
      return {
        kind: 'credential',
        scope,
        ask: `${agent} is out of usage on this account: add credit, or choose another account or model for this stage.`,
        why: 'Automatic retries hit the same usage wall; buying or reassigning usage is your decision.',
        recipient: OWNER,
        action: { kind: 'open-up-next', label: 'Choose account' },
        source: { type: 'provider-usage-limit', ref: agent }
      }
    case 'provider-approval':
      return {
        kind: 'approval',
        scope,
        ask: `Answer ${agent}'s startup prompt${input.detail ? ` (${input.detail})` : ''} in its conversation.`,
        why: `${agent} asks for an approval at startup that stayed after the host repaired what it may repair.`,
        recipient: OWNER,
        action: openConversation(input.paneKey, 'Open prompt'),
        source: { type: 'provider-approval', ref: `${agent}:${input.detail ?? 'startup'}` }
      }
    case 'brief-too-large':
      return {
        kind: 'clarification',
        scope,
        ask: 'Shorten this stage: its instruction and inputs are larger than an agent accepts.',
        why: 'Cutting what the stage is asked to read changes what you asked for, so the host will not do it.',
        recipient: OWNER,
        action: { kind: 'open-up-next', label: 'Edit stage' },
        source: { type: 'brief-too-large', ref: scope.stepId ?? scope.outcomeId }
      }
  }
}
