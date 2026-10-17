import { describe, expect, it } from 'vitest'
import { createWorkflowProgramContext, type WorkflowProgramCall } from '../workflow-program-context'
import { runDiscoverProgram, type DiscoverConfig } from './discover'
import { selectDiscoverFindings, type Finding, type FindingBatch } from './discover-assessment'

const config: DiscoverConfig = {
  finder: { id: 'finder', lineage: 'anthropic' },
  skeptics: [
    { id: 'skeptic-a', lineage: 'openai' },
    { id: 'skeptic-b', lineage: 'xai' }
  ],
  synthesizer: { id: 'skeptic-a', lineage: 'openai' },
  dimensions: ['Correctness', 'Actual user path', 'Reliability'],
  lenses: ['evidence', 'occurrence'],
  minimumSeverity: 'medium',
  maxCandidates: 12
}

function finding(issueKey: string, location: string, trigger: string): Finding {
  return {
    issueKey,
    title: issueKey,
    location,
    trigger,
    impact: 'Supported user impact',
    severity: 'high',
    evidence: [
      { ref: location.split(':').slice(0, -1).join(':') || location, description: trigger }
    ]
  }
}

function select(groups: Finding[][], revision: 1 | 2 | 3 = 3) {
  const batches: FindingBatch[] = groups.map((findings) => ({
    findings,
    omittedCount: 0,
    omissionReason: ''
  }))
  return selectDiscoverFindings(batches, { ...config, finderId: 'finder', revision })
}

describe('Discover quality regressions', () => {
  it('clusters transitive capability aliases at one code locus in revision 3 only', () => {
    const groups = [
      [
        finding(
          'download-missing-allowedFileId-check',
          'src/download.ts:1-11',
          'Public token requests private ID'
        )
      ],
      [
        finding(
          'download-missing-file-id-binding',
          'src/download.ts:1-11 (download)',
          'Other ID requested'
        )
      ],
      [
        finding(
          'download-token-file-binding-missing',
          'src/download.ts:1-11',
          'Private file fetched'
        )
      ]
    ]
    expect(select(groups, 2).selected).toHaveLength(3)
    const result = select(groups, 3)
    expect(result.selected).toHaveLength(1)
    expect(result.selected[0].sources).toHaveLength(3)
    expect(result.excluded).toHaveLength(2)
  })

  it('clusters ack/order and account aliases but preserves distinct same-file defects', () => {
    const ack = select([
      [finding('ack-before-durable-insert-order-loss', 'src/consumer.ts:1-10', 'Crash after ack')],
      [
        finding(
          'ack-before-insert-order-loss',
          'src/consumer.ts:1-10 (consume)',
          'Order disappears'
        )
      ],
      []
    ])
    expect(ack.selected).toHaveLength(1)
    const account = select([
      [
        finding('mass-assignment-isAdmin', 'src/account.ts:1-12', 'Member sets isAdmin'),
        finding(
          'unverified-email-becomes-active-recovery-email',
          'src/account.ts:1-12',
          'Email changes'
        )
      ],
      [
        finding(
          'mass-assignment-isAdmin-privilege-escalation',
          'src/account.ts:1-12 (update)',
          'Privilege granted'
        ),
        finding('unverified-email-takeover', 'src/account.ts:1-12 (update)', 'Recovery moves')
      ],
      []
    ])
    expect(account.selected).toHaveLength(2)
    expect(account.selected.map((item) => item.sources.length)).toEqual([2, 2])
  })
  it('deduplicates the tenantless report cache key across three perspectives', () => {
    const result = select([
      [
        finding('report-cache-key-missing-tenant', 'src/report.ts:1-4', 'Tenant B gets A cache hit')
      ],
      [
        finding(
          'report-cache-key-missing-tenant',
          'src/report.ts:1-9 (cache)',
          'B skips tenant query on hit'
        )
      ],
      [
        finding(
          'cross-tenant-cache-key-missing-tenant',
          'src/report.ts:1-4',
          'A and B share report ID'
        )
      ]
    ])
    expect(result.found).toBe(3)
    expect(result.selected).toHaveLength(1)
    expect(result.selected[0].sources).toHaveLength(3)
    expect(result.excluded.map((item) => item.reason)).toEqual(['duplicate', 'duplicate'])
  })

  it('deduplicates one payment race and one dialog focus defect despite different triggers', () => {
    const payment = select([
      [
        finding(
          'webhook-check-then-act-duplicate-capture',
          'src/webhook.ts:1-8 (handle)',
          'Two workers both check before capture'
        )
      ],
      [
        finding(
          'webhook-check-then-act-duplicate-capture',
          'src/webhook.ts:1-8 (handle)',
          'Two workers capture one charge'
        )
      ],
      [
        finding(
          'webhook-check-then-act-duplicate-capture',
          'src/webhook.ts:1-8 (handle)',
          'Crash after capture before mark'
        )
      ]
    ])
    const dialog = select([
      [finding('dialog-no-focus-management', 'src/Dialog.tsx:1-8', 'Keyboard user opens dialog')],
      [
        finding(
          'dialog-no-focus-management',
          'src/Dialog.tsx:1-8; contract:dialog',
          'Background field retains focus'
        )
      ],
      [
        finding(
          'dialog-no-focus-management',
          'src/Dialog.tsx:1-8',
          'Tab reaches background content'
        )
      ]
    ])
    expect(payment.selected).toHaveLength(1)
    expect(dialog.selected).toHaveLength(1)
    expect(payment.selected[0].sources).toHaveLength(3)
    expect(dialog.selected[0].sources).toHaveLength(3)
  })

  it('keeps distinct same-file root causes and disjoint line spans separate', () => {
    const result = select([
      [
        finding(
          'report-cache-key-missing-tenant',
          'src/report.ts:1-9',
          'Report cache ignores tenant'
        )
      ],
      [
        finding(
          'profile-cache-key-missing-tenant',
          'src/report.ts:1-9',
          'Profile cache ignores tenant'
        )
      ],
      [
        finding(
          'report-cache-key-missing-tenant',
          'src/report.ts:20-25',
          'Another report lookup ignores tenant'
        )
      ]
    ])
    expect(result.selected).toHaveLength(3)
    expect(result.excluded).toHaveLength(0)
  })

  it('asks skeptics to honor explicit supported-path contracts before ranking', async () => {
    const calls: WorkflowProgramCall[] = []
    const context = createWorkflowProgramContext({
      guard: () => {},
      isFatal: () => false,
      phase: () => {},
      log: () => {},
      agent: async (call) => {
        calls.push(call)
        if (call.id.startsWith('discover/')) {
          return {
            findings: [
              finding(
                'dialog-no-focus-management',
                'src/Dialog.tsx:1-8',
                'Background field retains focus'
              )
            ],
            omittedCount: 0,
            omissionReason: ''
          }
        }
        if (call.id.startsWith('refute/')) {
          return {
            refuted: false,
            uncertain: false,
            reason: 'Explicit contract establishes path',
            evidence: []
          }
        }
        const packet = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1))
        return {
          summary: 'One supported issue',
          ranking: packet.survivors.map((item: { id: string }) => ({
            findingId: item.id,
            reason: 'Supported path',
            nextAction: 'Fix focus handling'
          }))
        }
      }
    })
    const result = await runDiscoverProgram(context, config, {
      prompt: 'Inspect modal focus',
      evidence: 'contract:dialog says focus remains in the background'
    })
    const skeptical = calls.filter((call) => call.id.startsWith('refute/'))
    expect(calls).toHaveLength(6)
    expect(skeptical).toHaveLength(2)
    expect(
      skeptical.every((call) => call.prompt.includes('explicit facts in the frozen evidence'))
    ).toBe(true)
    expect(skeptical.every((call) => call.prompt.includes('historical incident log'))).toBe(true)
    expect(skeptical.every((call) => call.prompt.includes('Do not invent hidden guards'))).toBe(
      true
    )
    expect(result.selection.selected).toHaveLength(1)
    expect(result.survivors).toHaveLength(1)
  })
})
