import { describe, expect, it } from 'vitest'
import { computeBriefContentHash, deriveBriefStartIdentity } from './assisted-brief-hash'
import { buildBriefExecutionPrompt } from './assisted-brief-execution-prompt'
import { extractNamedModels } from './assisted-brief-named-models'
import { parseAssistedBriefRecord } from './assisted-brief-record-schema'
import {
  addPersonItem,
  answerBriefQuestions,
  applyBriefEdit,
  briefEditDraft,
  createBriefRecord,
  currentBriefRevision,
  isBriefRequestTooLong,
  isBriefSectionFull,
  rebindBriefWorkspace,
  removeBriefItem,
  sectionsOverflowedByAnswers,
  splitBriefLines
} from './assisted-brief-revisions'
import {
  currentRevisionStart,
  planBriefStart,
  reconcileBriefStarts,
  releaseUnconfirmedStart,
  settleBriefStart,
  type BriefTabProbe
} from './assisted-brief-start'
import {
  ASSISTED_BRIEF_LIMITS,
  type AssistedBriefRecord,
  type BriefClock,
  type BriefContent
} from './assisted-brief-types'

let counter = 0
const clock = (now: number): BriefClock => ({ now, newId: () => `id${++counter}` })
const WORKSPACE = '["repo-1::/work/app","local"]'
const OTHER_WORKSPACE = '["repo-1::/work/app","ssh:box"]'
const REQUEST =
  'Write a one-page launch summary with claude-fable-5-1[1m], then have gpt-6-astra check it.'
const absent: BriefTabProbe = () => 'absent'
const present: BriefTabProbe = () => 'present'
const unknown: BriefTabProbe = () => 'unknown'

function draftContent(): BriefContent {
  return {
    outcome: { id: 'o1', text: 'A one-page launch summary', origin: 'request' },
    sections: {
      scope: [{ id: 's1', text: 'Cover the launch date and owners', origin: 'request' }],
      constraints: [{ id: 'c1', text: 'Draft with claude-fable-5-1[1m]', origin: 'request' }],
      assumptions: [{ id: 'a1', text: 'The audience is internal', origin: 'ai-assumption' }],
      deliverables: [{ id: 'd1', text: 'A Markdown file', origin: 'ai-suggestion' }],
      successChecks: []
    },
    questions: [
      { id: 'q1', prompt: 'Which tone?', choices: ['Formal', 'Casual'], section: 'constraints' }
    ]
  }
}

function newRecord(content = draftContent(), request = REQUEST): AssistedBriefRecord {
  return createBriefRecord({
    briefId: 'b1',
    workspaceKey: WORKSPACE,
    original: { text: request, attachments: [{ name: 'notes.md', path: '/work/app/notes.md' }] },
    drafter: { agent: 'claude', model: 'claude-fable-5-1[1m]', label: 'Claude Teams · Fable' },
    content,
    now: 1_000
  })
}

function startInput(now: number, probe: BriefTabProbe = absent, verifiable = true) {
  return { workspaceKey: WORKSPACE, favoriteId: 'claude-teams-fable', verifiable, now, probe }
}

function launched(record: AssistedBriefRecord, now = 2_000) {
  const plan = planBriefStart(record, startInput(now))
  if (plan.kind !== 'launch') {
    throw new Error(`expected a launch, got ${plan.kind}`)
  }
  return plan
}

/** Simulates an app restart: the saved JSON is read back through the validating schema. */
const restart = (record: AssistedBriefRecord) =>
  parseAssistedBriefRecord(JSON.parse(JSON.stringify(record)))

describe('content hash and approval binding', () => {
  it('hashes content and workspace but not item ids', () => {
    const context = {
      workspaceKey: WORKSPACE,
      original: { text: REQUEST, attachments: [] },
      namedModels: []
    }
    const base = computeBriefContentHash(draftContent(), context)
    const renamed = draftContent()
    renamed.sections.scope[0].id = 'another-id'
    expect(computeBriefContentHash(renamed, context)).toBe(base)
    const edited = draftContent()
    edited.sections.scope[0].text = 'Cover the launch date'
    expect(computeBriefContentHash(edited, context)).not.toBe(base)
    expect(
      computeBriefContentHash(draftContent(), { ...context, workspaceKey: OTHER_WORKSPACE })
    ).not.toBe(base)
  })

  it('binds approval to the revision, its hash and the workspace, and drops it on any change', () => {
    const { record } = launched(newRecord())
    expect(record.approval).toEqual({
      revision: 1,
      contentHash: currentBriefRevision(record).contentHash,
      workspaceKey: WORKSPACE,
      approvedAt: 2_000
    })
    const edited = addPersonItem(record, 'scope', 'Mention the pricing change', clock(3_000))!
    expect(edited.approval).toBeNull()
    expect(rebindBriefWorkspace(record, OTHER_WORKSPACE, 3_000).approval).toBeNull()
  })

  it('gives a brief moved to another workspace a new revision that needs a new approval', () => {
    const { record } = launched(newRecord())
    expect(planBriefStart(record, { ...startInput(3_000), workspaceKey: OTHER_WORKSPACE })).toEqual(
      {
        kind: 'refused',
        reason: 'workspace-changed'
      }
    )
    const rebound = rebindBriefWorkspace(record, OTHER_WORKSPACE, 3_000)
    const revision = currentBriefRevision(rebound)
    expect(revision).toMatchObject({ number: 2, cause: 'workspace-changed' })
    expect(revision.contentHash).not.toBe(record.revisions[0].contentHash)
    expect(rebound.approval).toBeNull()
  })

  it('makes every edit or answer a new revision and keeps who wrote each line', () => {
    const record = newRecord()
    const added = addPersonItem(record, 'scope', 'Mention pricing', clock(2_000))!
    expect(currentBriefRevision(added)).toMatchObject({ number: 2, cause: 'added' })
    const answered = answerBriefQuestions(added, { q1: 'Formal' }, clock(3_000))!
    const answeredContent = currentBriefRevision(answered).content
    expect(currentBriefRevision(answered).cause).toBe('answered')
    expect(answeredContent.questions).toEqual([])
    expect(answeredContent.sections.constraints.at(-1)).toMatchObject({
      text: 'Which tone? — Formal',
      origin: 'answer'
    })
    const removed = removeBriefItem(answered, 'd1', clock(4_000))!
    expect(currentBriefRevision(removed).cause).toBe('removed')
    const draft = briefEditDraft(currentBriefRevision(removed).content)
    expect(applyBriefEdit(removed, draft, clock(5_000))).toBeNull()
    draft.sections.scope = 'Cover the launch date and owners\nAdd a customer quote'
    const edited = currentBriefRevision(applyBriefEdit(removed, draft, clock(5_000))!)
    expect(edited.cause).toBe('edited')
    expect(edited.content.sections.scope.map((item) => item.origin)).toEqual(['request', 'person'])
  })
})

describe('a single start per approved revision', () => {
  it('refuses a second click while the first start is in flight or done', () => {
    const plan = launched(newRecord())
    expect(plan.start).toMatchObject({ status: 'starting', revision: 1 })
    expect(planBriefStart(plan.record, startInput(2_001))).toEqual({
      kind: 'refused',
      reason: 'in-flight'
    })
    const settled = settleBriefStart(
      plan.record,
      plan.start.operationId,
      { ok: true, tabId: plan.start.tabId },
      2_002
    )
    expect(currentRevisionStart(settled)?.status).toBe('started')
    expect(planBriefStart(settled, startInput(2_003))).toEqual({
      kind: 'refused',
      reason: 'already-started'
    })
  })

  it('reconciles a start that was saved but not settled before a restart', () => {
    const plan = launched(newRecord())
    const restored = restart(plan.record)
    expect(currentRevisionStart(reconcileBriefStarts(restored, present, 3_000))).toMatchObject({
      status: 'started',
      launchedTabId: plan.start.tabId
    })
    const missing = reconcileBriefStarts(restored, absent, 3_000)
    expect(currentRevisionStart(missing)?.status).toBe('unconfirmed')
    expect(planBriefStart(missing, startInput(3_001))).toEqual({
      kind: 'refused',
      reason: 'needs-confirmation'
    })
  })

  it('finds the running session when the start write was lost, instead of launching again', () => {
    const plan = planBriefStart(newRecord(), startInput(2_000, present))
    expect(plan.kind).toBe('already-running')
    expect(plan.kind === 'already-running' && plan.start.status).toBe('started')
  })

  it('does not start while saved tabs are still being restored', () => {
    expect(planBriefStart(newRecord(), startInput(2_000, unknown))).toEqual({
      kind: 'refused',
      reason: 'sessions-restoring'
    })
  })

  it('waits for tabs to be restored before judging an uncertain start', () => {
    const plan = launched(newRecord())
    const waiting = reconcileBriefStarts(plan.record, unknown, 3_000)
    expect(currentRevisionStart(waiting)?.status).toBe('starting')
    expect(planBriefStart(waiting, startInput(3_001)).kind).toBe('refused')
    expect(currentRevisionStart(reconcileBriefStarts(waiting, present, 4_000))?.status).toBe(
      'started'
    )
  })

  it('cannot verify paired-host starts, so it asks instead of assuming', () => {
    const plan = planBriefStart(newRecord(), startInput(2_000, present, false))
    expect(plan.kind).toBe('launch')
    const record = plan.kind === 'launch' ? plan.record : newRecord()
    expect(currentRevisionStart(reconcileBriefStarts(record, present, 3_000))?.status).toBe(
      'unconfirmed'
    )
  })

  it('retries a definite failure or a released start under the same operation', () => {
    const plan = launched(newRecord())
    const failed = settleBriefStart(
      plan.record,
      plan.start.operationId,
      { ok: false, failure: 'launch-failed' },
      2_001
    )
    const retry = launched(failed, 2_002)
    expect(retry.start).toMatchObject({
      operationId: plan.start.operationId,
      tabId: plan.start.tabId
    })
    const unconfirmed = reconcileBriefStarts(retry.record, absent, 3_000)
    const released = releaseUnconfirmedStart(unconfirmed, plan.start.operationId, 3_001)
    expect(launched(released, 3_002).start.operationId).toBe(plan.start.operationId)
  })

  it('gives a changed brief a new operation and a stable, UUID-shaped tab id', () => {
    const plan = launched(newRecord())
    const settled = settleBriefStart(
      plan.record,
      plan.start.operationId,
      { ok: true, tabId: plan.start.tabId },
      2_001
    )
    const changed = addPersonItem(settled, 'scope', 'Include the FAQ', clock(3_000))!
    expect(launched(changed, 3_001).start.operationId).not.toBe(plan.start.operationId)
    const identity = deriveBriefStartIdentity('b1', 1, plan.start.contentHash)
    expect(identity).toEqual({ operationId: plan.start.operationId, tabId: plan.start.tabId })
    expect(identity.tabId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })
})

describe('requirements, suggestions and named models', () => {
  it('keeps the person’s requirements apart from AI proposals', () => {
    const { requirements, proposals } = splitBriefLines(draftContent())
    expect(requirements.map((line) => line.item.id)).toEqual(['s1', 'c1'])
    expect(proposals.map((line) => line.item.id)).toEqual(['a1', 'd1'])
    const prompt = buildBriefExecutionPrompt(newRecord())
    const [requirementsPart, proposalsPart] = prompt.split('AI suggestions and assumptions')
    expect(requirementsPart).toContain(
      "Scope (the person's requirements):\n- Cover the launch date and owners"
    )
    expect(requirementsPart).not.toContain('The audience is internal')
    expect(proposalsPart).toContain('- Assumptions: The audience is internal (AI assumption)')
    expect(prompt).toContain(`<<<\n${REQUEST}\n>>>`)
    expect(prompt).toContain('- notes.md: /work/app/notes.md')
  })

  it('copies named models from the request verbatim and keeps them through edits', () => {
    const record = newRecord()
    expect(record.namedModels).toEqual(['claude-fable-5-1[1m]', 'gpt-6-astra'])
    const draft = briefEditDraft(currentBriefRevision(record).content)
    draft.sections.constraints = 'Draft with gpt-5.5'
    const edited = applyBriefEdit(record, draft, clock(2_000))!
    expect(edited.namedModels).toEqual(['claude-fable-5-1[1m]', 'gpt-6-astra'])
    expect(buildBriefExecutionPrompt(edited)).toContain(
      'Use them exactly as written:\n- claude-fable-5-1[1m]\n- gpt-6-astra'
    )
  })

  it('reads model names but not poem forms or story types', () => {
    expect(
      extractNamedModels(
        'Use Claude Teams with claude-fable-5-1[1m] and gpt-6-astra. Sonnet 4.6 reviews.'
      )
    ).toEqual(['claude-fable-5-1[1m]', 'gpt-6-astra', 'Sonnet 4.6'])
    expect(
      extractNamedModels('Write a sonnet about spring and a short fable for children.')
    ).toEqual([])
  })

  it('does not read numbered poems, opus numbers, visas or style words as models', () => {
    expect(
      extractNamedModels("Analyse Shakespeare's Sonnet 18 and compare it with Sonnet 130.")
    ).toEqual([])
    expect(extractNamedModels('Write programme notes for Beethoven Opus 27 No. 2.')).toEqual([])
    expect(extractNamedModels('Summarise the O1 visa process.')).toEqual([])
    expect(extractNamedModels('Write a GPT-style FAQ and a Claude-written summary.')).toEqual([])
    expect(
      extractNamedModels('Ask Claude Sonnet 4 and OpenAI o3, then o4-mini-high and opus-4-1.')
    ).toEqual(['Claude Sonnet 4', 'o3', 'o4-mini-high', 'opus-4-1'])
  })

  it('labels an outcome in the AI’s wording in the prompt Start sends', () => {
    expect(buildBriefExecutionPrompt(newRecord())).toContain(
      '\nOutcome: A one-page launch summary\n'
    )
    const content = draftContent()
    content.outcome.origin = 'ai-suggestion'
    expect(buildBriefExecutionPrompt(newRecord(content))).toContain(
      '\nOutcome: A one-page launch summary (AI wording)\n'
    )
  })
})

describe('limits the drawer shows instead of applying silently', () => {
  it('keeps a request verbatim and refuses to store one over the limit', () => {
    const long = 'x'.repeat(ASSISTED_BRIEF_LIMITS.requestChars + 1)
    expect(isBriefRequestTooLong(REQUEST)).toBe(false)
    expect(isBriefRequestTooLong(long)).toBe(true)
    const record = newRecord(draftContent(), long)
    expect(record.original.text).toBe(long)
    expect(() => parseAssistedBriefRecord(record)).toThrow()
  })

  it('reports a full section before a line or an answer is added', () => {
    const content = draftContent()
    content.sections.constraints = Array.from(
      { length: ASSISTED_BRIEF_LIMITS.itemsPerSection },
      (_, index) => ({ id: `f${index}`, text: `Constraint ${index}`, origin: 'person' as const })
    )
    const record = newRecord(content)
    expect(isBriefSectionFull(content, 'constraints')).toBe(true)
    expect(isBriefSectionFull(content, 'scope')).toBe(false)
    expect(addPersonItem(record, 'constraints', 'One more', clock(2_000))).toBeNull()
    expect(sectionsOverflowedByAnswers(content, { q1: 'Formal' })).toEqual(['constraints'])
    expect(sectionsOverflowedByAnswers(content, { q1: '  ' })).toEqual([])
    expect(answerBriefQuestions(record, { q1: 'Formal' }, clock(2_000))).toBeNull()
  })
})
