import { describe, expect, it } from 'vitest'
import { normalizeSessionChains } from './session-chain-types'
import { isHostWaitingFollowUp } from './session-chain-retention'
import {
  canRecaptureSessionFollowUp,
  normalizeSessionFollowUpRule,
  sessionFollowUpNeedsConfirmedFinish,
  type SessionFollowUpException,
  type SessionFollowUpRule
} from './session-follow-up-rule'

function rule(extra: Partial<SessionFollowUpRule> = {}): SessionFollowUpRule {
  return {
    revision: 1,
    taskId: 'btk_abcd1234',
    taskTitle: 'Webinar intro',
    sessionLabel: 'Draft',
    recipients: [
      { employeeId: 'emp_iris', name: 'Iris', operationId: 'fu_iris_key', delivery: 'pending' }
    ],
    action: 'review',
    deliverables: { kind: 'files', paths: ['/w/report.md'] },
    includeSummary: false,
    note: 'Please review',
    savedAt: 1,
    ...extra
  }
}

function failed(code: SessionFollowUpException['code']): SessionFollowUpException {
  return { code, subject: '', detail: '', at: 3 }
}

describe('saved follow-up rule', () => {
  it('keeps a card-less rule (an explicit null card) and refuses a missing or malformed card', () => {
    expect(normalizeSessionFollowUpRule(rule({ taskId: null }))?.taskId).toBeNull()
    expect(normalizeSessionFollowUpRule({ ...rule(), taskId: undefined })).toBeNull()
    expect(normalizeSessionFollowUpRule(rule({ taskId: 'dcn_1234' as never }))).toBeNull()
  })

  it('needs a confirmed finish for named files, never for a run manifest', () => {
    expect(sessionFollowUpNeedsConfirmedFinish(rule())).toBe(true)
    expect(
      sessionFollowUpNeedsConfirmedFinish(
        rule({ deliverables: { kind: 'manifest', manifestPath: '/w/out/manifest.md' } })
      )
    ).toBe(false)
  })
  it('keeps a message-only rule and requires completion evidence before delivery', () => {
    const normalized = normalizeSessionFollowUpRule(
      rule({
        taskId: null,
        includeSummary: false,
        deliverables: { kind: 'files', paths: [] },
        communicationType: 'information'
      })
    )!
    expect(normalized).toMatchObject({
      deliverables: { kind: 'files', paths: [] },
      includeSummary: false,
      communicationType: 'information'
    })
    expect(sessionFollowUpNeedsConfirmedFinish(normalized)).toBe(true)
  })

  it('retains exact conversation delivery metadata for employee rules across chain reloads', () => {
    const handoff = rule({ sourceConversationId: 'chat_original', communicationType: 'request' })
    const chains = normalizeSessionChains([
      {
        id: 'chn_original',
        workspacePath: '/w',
        worktreeId: 'folder:w',
        sourcePaneKey: 'tab:leaf',
        sourceRowKey: 'row',
        steps: [{ id: 'step_1', kind: 'handoff', status: 'queued', handoff }]
      }
    ])
    expect(chains[0]?.steps[0]).toMatchObject({
      kind: 'handoff',
      handoff: { sourceConversationId: 'chat_original', communicationType: 'request' }
    })
    expect(
      normalizeSessionFollowUpRule({ ...handoff, sourceConversationId: 'invalid source' })
    ).toBeNull()
  })

  it('preserves captured history for replay and refuses an incomplete history pin', () => {
    const file = { name: 'history.md', contentBase64: 'eA==', size: 1, sha256: 'a'.repeat(64) }
    const source = {
      kind: 'provider' as const,
      hostId: 'ssh:owner' as const,
      agent: 'codex',
      sessionId: 'original-session'
    }
    const saved = rule({
      transcriptSource: source,
      capturedAt: 4,
      transcriptFile: file,
      files: [
        {
          sourcePath: null,
          generatedKind: 'transcript',
          name: file.name,
          size: file.size,
          sha256: file.sha256
        }
      ]
    })
    expect(normalizeSessionFollowUpRule(JSON.parse(JSON.stringify(saved)))).toMatchObject({
      transcriptSource: source,
      transcriptFile: file,
      capturedAt: 4,
      files: saved.files
    })
    expect(
      normalizeSessionFollowUpRule({ ...saved, transcriptFile: undefined })?.capturedAt
    ).toBeUndefined()
    expect(
      normalizeSessionFollowUpRule({
        ...saved,
        transcriptFile: { ...file, sha256: 'b'.repeat(64) }
      })?.capturedAt
    ).toBeUndefined()
    expect(
      normalizeSessionFollowUpRule({ ...saved, transcriptSource: { ...source, hostId: 'unknown' } })
    ).toBeNull()
  })

  it('keeps the ready and confirmed marks and the unverifiable exception across a reload', () => {
    expect(
      normalizeSessionFollowUpRule({
        ...rule(),
        readyAt: 4,
        confirmedAt: 5,
        exception: failed('unverifiable')
      })
    ).toMatchObject({ readyAt: 4, confirmedAt: 5, exception: { code: 'unverifiable' } })
  })

  it('keeps how many automatic resends a failure has cost, and drops a count it cannot trust', () => {
    const reload = (retries: unknown) =>
      normalizeSessionFollowUpRule({ ...rule(), exception: { ...failed('unconfirmed'), retries } })
        ?.exception
    expect(reload(2)).toMatchObject({ code: 'unconfirmed', retries: 2 })
    for (const untrusted of [0, -1, 1.5, '2', null, Number.NaN, 1_001]) {
      expect(reload(untrusted)).not.toHaveProperty('retries')
    }
    // A record written before the field existed reads exactly as it did.
    expect(
      normalizeSessionFollowUpRule({ ...rule(), exception: failed('unconfirmed') })?.exception
    ).not.toHaveProperty('retries')
  })

  it('starts a capture over only when no request can have left', () => {
    const changed = rule({ capturedAt: 5, files: [], exception: failed('files-changed') })
    expect(canRecaptureSessionFollowUp(changed)).toBe(true)
    expect(canRecaptureSessionFollowUp({ ...changed, exception: failed('unreadable') })).toBe(true)
    expect(
      canRecaptureSessionFollowUp({
        ...changed,
        recipients: [{ ...changed.recipients[0]!, delivery: 'sending' }]
      })
    ).toBe(false)
    expect(canRecaptureSessionFollowUp({ ...changed, exception: failed('unconfirmed') })).toBe(
      false
    )
    const { capturedAt: _captured, ...uncaptured } = changed
    expect(canRecaptureSessionFollowUp(uncaptured)).toBe(false)
  })

  it('resumes on load only a stop whose host or run could not be verified', () => {
    const chains = normalizeSessionChains(
      (['unverifiable', 'host-unreachable', 'run-failed'] as const).map((code) => ({
        id: `chn_${code}`,
        workspacePath: '/w',
        worktreeId: 'folder:f1',
        hostId: 'local',
        sourcePaneKey: 'tab-1:leaf-1',
        sourceRowKey: 'row',
        auto: true,
        steps: [
          {
            kind: 'handoff',
            id: 'step_h',
            status: 'queued',
            handoff: rule({ exception: failed(code) })
          }
        ],
        currentIndex: 0,
        state: 'failed',
        createdAt: 1,
        updatedAt: 2
      }))
    )
    expect(chains.map(isHostWaitingFollowUp)).toEqual([true, true, false])
  })

  it('keeps the mark that the sender typed the note, and nothing that only resembles it', () => {
    expect(normalizeSessionFollowUpRule(rule({ noteAuthored: true }))?.noteAuthored).toBe(true)
    expect(normalizeSessionFollowUpRule(rule())).not.toHaveProperty('noteAuthored')
    expect(normalizeSessionFollowUpRule({ ...rule(), noteAuthored: 'yes' })).not.toHaveProperty(
      'noteAuthored'
    )
  })

  it('keeps a rule with no requested action: the work says it', () => {
    const { action: _dropped, ...noAction } = rule()
    const normalized = normalizeSessionFollowUpRule(noAction)
    expect(normalized).not.toBeNull()
    expect(normalized?.action).toBeUndefined()
    expect(normalizeSessionFollowUpRule({ ...noAction, action: 'bogus' })?.action).toBeUndefined()
  })

  it('normalizes an explicit disposition without changing legacy review semantics', () => {
    expect(
      normalizeSessionFollowUpRule(rule({ disposition: 'ownership-transfer' }))?.disposition
    ).toBe('ownership-transfer')
    expect(
      normalizeSessionFollowUpRule({ ...rule(), disposition: 'unsupported' })?.disposition
    ).toBeUndefined()
  })

  it('carries several manifests for a fan-out, bounded and de-duplicated', () => {
    const many = normalizeSessionFollowUpRule(
      rule({
        deliverables: {
          kind: 'manifests',
          manifestPaths: [
            '/w/.omni/runs/c/s1/manifest.md',
            '/w/.omni/runs/c/s1/manifest.md',
            '/w/.omni/runs/c/s2/manifest.md'
          ]
        }
      })
    )
    expect(many?.deliverables).toEqual({
      kind: 'manifests',
      manifestPaths: ['/w/.omni/runs/c/s1/manifest.md', '/w/.omni/runs/c/s2/manifest.md']
    })
    expect(sessionFollowUpNeedsConfirmedFinish(many!)).toBe(false)
    expect(
      normalizeSessionFollowUpRule(rule({ deliverables: { kind: 'manifests', manifestPaths: [] } }))
    ).toBeNull()
  })
})
