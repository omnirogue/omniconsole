import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ExactHandoffFile } from './console-handoff-contract'
import { deliverSessionFollowUp } from './session-follow-up-delivery'
import type { FollowUpDeliveryContext } from './session-follow-up-delivery-contract'
import type { SessionFollowUpRule } from './session-follow-up-rule'

const PAGE = {
  slug: 'launch-plan',
  title: 'Launch plan',
  url: 'https://console.example.com/a/launch-plan'
}

function exact(name: string, text: string): ExactHandoffFile {
  const bytes = Buffer.from(text)
  return {
    name,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentBase64: bytes.toString('base64')
  }
}
const summary = exact('draft-final-summary.md', '# summary')

function rule(extra: Partial<SessionFollowUpRule> = {}): SessionFollowUpRule {
  return {
    revision: 1,
    taskId: 'btk_abcd1234',
    taskTitle: 'Webinar intro',
    sessionLabel: 'Draft',
    recipients: [
      { employeeId: 'emp_iris', name: 'Iris', operationId: 'fu_iris_op', delivery: 'pending' }
    ],
    deliverables: { kind: 'files', paths: [] },
    includeSummary: true,
    note: 'Please look at the plan',
    savedAt: 1,
    capturedAt: 2,
    files: [{ sourcePath: null, name: summary.name, sha256: summary.sha256, size: summary.size }],
    summaryMarkdown: '# summary',
    ...extra
  }
}

function harness(start: SessionFollowUpRule) {
  let saved = start
  const ctx: FollowUpDeliveryContext = {
    current: () => saved,
    save: vi.fn(async (next: SessionFollowUpRule) => {
      saved = next
    }),
    hub: {
      upload: vi.fn(async (_taskId: string, file: ExactHandoffFile) => ({
        path: `handoffs/${file.name}`,
        sha256: file.sha256
      })),
      send: vi.fn(async (input) => ({ thread_id: `hth_${input.recipient.slice(4)}` })),
      sendCardless: vi.fn(async (input) => ({ thread_id: `hth_${input.recipient.slice(4)}` })),
      uploadThreadFile: vi.fn(async (input) => ({ thread_id: input.threadId })),
      isRejected: () => false
    },
    bytes: vi.fn(async () => summary),
    now: () => 1000,
    sleep: vi.fn(async () => undefined)
  }
  return ctx
}

describe('a follow-up that carries a page for review', () => {
  it('asks the recipient to review "Review: <title>" with the page link and reference', async () => {
    const ctx = harness(rule({ artifactReview: PAGE }))
    await expect(deliverSessionFollowUp(ctx)).resolves.toBe('delivered')
    expect(ctx.hub.send).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: 'emp_iris',
        title: 'Review: Launch plan',
        action: 'review',
        note: `Please look at the plan\n\nReview the page and decide there: ${PAGE.url}`,
        artifactReview: PAGE
      })
    )
  })

  it('leaves an ordinary follow-up as it was', async () => {
    const ctx = harness(rule())
    await deliverSessionFollowUp(ctx)
    const [input] = vi.mocked(ctx.hub.send).mock.calls[0]!
    expect(input).not.toHaveProperty('artifactReview')
    expect(input.title).not.toMatch(/^Review: /)
  })
})
