import { describe, expect, it } from 'vitest'
import { AGENT_HOOK_PROMPT_REPLY_MAX_BYTES } from '../../shared/agent-hook-prompt-reply-limit'
import {
  ARTIFACT_APPROVAL_SCOPE_LINE,
  artifactDecisionMessage
} from '../../shared/artifact-review-decision-message'
import { answerFitsHookReply, compactAnswerFor, fitHookAnswerReply } from './answer-inbox-render'

const decision = (comment: string, edits: Record<string, string> | null = null) =>
  artifactDecisionMessage({
    slug: 'plan-page',
    title: 'Ad budget plan',
    shareUrl: 'https://app.omnisi.ai/a/plan-page',
    decision: {
      id: '42',
      decision: 'approved',
      revision: 2,
      comment,
      edits,
      at: '2026-10-17T21:00:00Z',
      by: { name: 'Sal', email: 'sal@example.com' }
    }
  })

const review = (context: Record<string, unknown>) => ({
  kind: 'review' as const,
  workItem: 'review:plan-page',
  context: {
    slug: 'plan-page',
    title: 'Ad budget plan',
    revision: 2,
    decision: 'approved',
    ...context
  }
})

describe('hook answer replies', () => {
  it('carries a short answer word for word in each event shape', () => {
    const text = decision('Looks good')
    expect(JSON.parse(fitHookAnswerReply('UserPromptSubmit', text, null)!)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text }
    })
    expect(JSON.parse(fitHookAnswerReply('PostToolUse', text, null)!).hookSpecificOutput).toEqual({
      hookEventName: 'PostToolUse',
      additionalContext: text
    })
    expect(JSON.parse(fitHookAnswerReply('SessionStart', text, null)!).hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: text
    })
    expect(JSON.parse(fitHookAnswerReply('Stop', text, null)!)).toEqual({
      decision: 'block',
      reason: text
    })
  })

  it('builds the shortened copy from the delivery fields, never from a command quoted in the text', () => {
    // A reviewer comment quoting another page's command must not become the pointer.
    const text = decision(`run omni artifacts status other-page --json ${'x'.repeat(400)}`, {
      budget: 'y'.repeat(900)
    })
    expect(Buffer.byteLength(text)).toBeGreaterThan(AGENT_HOOK_PROMPT_REPLY_MAX_BYTES)
    const compact = compactAnswerFor(review({}))
    const reply = fitHookAnswerReply('PostToolUse', text, compact)!
    expect(Buffer.byteLength(reply)).toBeLessThanOrEqual(AGENT_HOOK_PROMPT_REPLY_MAX_BYTES)
    const context = JSON.parse(reply).hookSpecificOutput.additionalContext as string
    expect(context).toBe(compact)
    expect(context.split('\n')[0]).toBe(
      '[OmniOS decision] Approved: revision 2 of "Ad budget plan"'
    )
    expect(context).toContain('Full answer: run `omni artifacts status plan-page --json`')
    expect(context).not.toContain('other-page')
    expect(context).toContain('carry out only what revision 2 says')
    expect(context).toContain('publish the edited version as revision 3 for approval')
    expect(context).toContain(ARTIFACT_APPROVAL_SCOPE_LINE)
  })

  it('words each decision as its own limits and refuses fields it cannot trust', () => {
    expect(compactAnswerFor(review({ decision: 'rejected' }))).toContain(
      'Do now: stop. Do not carry out the plan or publish it again.'
    )
    expect(compactAnswerFor(review({ decision: 'changes_requested' }))).toContain(
      'Do not carry out the plan.'
    )
    expect(compactAnswerFor(review({ decision: 'something-new' }))).toContain(
      'this is not an approval'
    )
    expect(compactAnswerFor(review({ slug: 'bad slug; rm -rf' }))).toBeNull()
    expect(compactAnswerFor(review({ revision: 'two' }))).toBeNull()
    const jira = compactAnswerFor({ kind: 'jira', workItem: 'jira:OMR-93', context: {} })
    expect(jira).toContain('Full answer: run `omni-jira get OMR-93 --comments 20`')
    expect(compactAnswerFor({ kind: 'jira', workItem: 'jira:`x`', context: {} })).toBeNull()
    expect(compactAnswerFor({ kind: 'message', workItem: 'm', context: {} })).toBeNull()
  })

  it('refuses an over-cap answer that has no shortened copy', () => {
    const text = `[OmniOS message] From Sal, sent from Claude (their own words):\n${'z'.repeat(1200)}`
    expect(fitHookAnswerReply('Stop', text, null)).toBeNull()
    expect(answerFitsHookReply(text, null)).toBe(false)
    expect(answerFitsHookReply('[OmniOS message] From Sal: ship it', null)).toBe(true)
  })

  it('puts the answer first and the next-step pointer after it when both fit', () => {
    const reply = fitHookAnswerReply('UserPromptSubmit', 'answer text', null, 'pointer text')!
    expect(JSON.parse(reply).hookSpecificOutput.additionalContext).toBe(
      'answer text\n\npointer text'
    )
    expect(fitHookAnswerReply('UserPromptSubmit', 'answer', null, 'p'.repeat(1100))).toBeNull()
  })
})
