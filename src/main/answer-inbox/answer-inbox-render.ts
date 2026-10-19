/**
 * The provider reply that carries an answer, under the 1 KB ceiling every managed hook reply
 * shares. The answer goes in word for word; one too long goes as a shortened copy built only from
 * the delivery's structured fields (page slug, decision, revision, Jira key), never from its text,
 * so a quoted command or line in a comment can never stand in for the pointer or the limits.
 */

import { AGENT_HOOK_PROMPT_REPLY_MAX_BYTES } from '../../shared/agent-hook-prompt-reply-limit'
import { ARTIFACT_APPROVAL_SCOPE_LINE } from '../../shared/artifact-review-decision-message'
import type { ClaimableDelivery } from '../work-delivery/work-delivery-kind'
import type { AnswerHookEvent } from './answer-inbox'

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/

const field = (context: Record<string, unknown>, name: string) => context[name]

function plainTitle(value: unknown, fallback: string): string {
  const title = typeof value === 'string' ? value.replace(/[\s`"]+/g, ' ').trim() : ''
  return (title || fallback).slice(0, 120)
}

function reviewAuthority(decision: unknown, revision: number): { verb: string; lines: string[] } {
  switch (decision) {
    case 'approved':
      return {
        verb: 'Approved: revision',
        lines: [
          `Do now: read the full decision first, then carry out only what revision ${revision} says, with any edits or answers it carries.`,
          `If an edit changes money, a customer send, an ad budget or access, do not act: publish the edited version as revision ${revision + 1} for approval (omni artifacts update <file> --review …).`,
          ARTIFACT_APPROVAL_SCOPE_LINE
        ]
      }
    case 'changes_requested':
      return {
        verb: 'Changes requested on revision',
        lines: [
          'Do now: read the full decision, revise the plan to cover every point and publish it as a new revision of the same page (omni artifacts update <file> --review …). Do not carry out the plan.'
        ]
      }
    case 'rejected':
      return {
        verb: 'Rejected: revision',
        lines: ['Do now: stop. Do not carry out the plan or publish it again.']
      }
    default:
      return {
        verb: 'A decision that is not an approval on revision',
        lines: [
          'Do now: this is not an approval, so do not carry out the plan. Read the decision, and ask the person what they want if it is unclear.'
        ]
      }
  }
}

/** The shortened copy for a review decision or a Jira reply; null for every other kind. */
export function compactAnswerFor(
  delivery: Pick<ClaimableDelivery, 'kind' | 'context' | 'workItem'>
): string | null {
  const context = delivery.context ?? {}
  if (delivery.kind === 'review') {
    const slug = field(context, 'slug')
    const revision = Number(field(context, 'revision'))
    if (typeof slug !== 'string' || !SLUG.test(slug) || !Number.isInteger(revision)) {
      return null
    }
    const { verb, lines } = reviewAuthority(field(context, 'decision'), revision)
    return [
      `[OmniOS decision] ${verb} ${revision} of "${plainTitle(field(context, 'title'), slug)}"`,
      `This is a shortened copy. Full answer: run \`omni artifacts status ${slug} --json\` and read it before you act.`,
      ...lines
    ].join('\n')
  }
  const key = delivery.kind === 'jira' ? delivery.workItem.replace(/^jira:/, '') : ''
  if (!JIRA_KEY.test(key)) {
    return null
  }
  return [
    `[OmniOS QA reply] A new comment on ${key}`,
    `This is a shortened copy. Full answer: run \`omni-jira get ${key} --comments 20\` and read the whole thread before you act.`,
    `Do now: fix everything you can fix now, keep the PR checks green, and post a re-test handoff on ${key} for the tester. Publish an OmniOS decision page only when there is a real choice Sal or Uma must make.`
  ].join('\n')
}

export function hookAnswerReplyBody(event: AnswerHookEvent, context: string): string {
  return event === 'Stop'
    ? JSON.stringify({ decision: 'block', reason: context })
    : JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })
}

function fits(body: string): boolean {
  return Buffer.byteLength(body, 'utf8') <= AGENT_HOOK_PROMPT_REPLY_MAX_BYTES
}

/**
 * The reply for `event` carrying the answer (answer first, then `extraContext`), full text if it
 * fits, else the shortened copy; null when neither fits.
 */
export function fitHookAnswerReply(
  event: AnswerHookEvent,
  text: string,
  compact: string | null,
  extraContext?: string
): string | null {
  for (const variant of compact ? [text, compact] : [text]) {
    const body = hookAnswerReplyBody(
      event,
      extraContext ? `${variant}\n\n${extraContext}` : variant
    )
    if (fits(body)) {
      return body
    }
  }
  return null
}

/** Whether the answer can ride every hook reply shape (the longest event name is the bound). */
export function answerFitsHookReply(text: string, compact: string | null): boolean {
  return fitHookAnswerReply('UserPromptSubmit', text, compact) !== null
}
