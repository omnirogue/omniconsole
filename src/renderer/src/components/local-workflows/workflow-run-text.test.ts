import { describe, expect, it, vi } from 'vitest'
import { deanonymizeCouncilText, councilRankCall, councilStandingRows } from './council-run-text'
import {
  discoverCallTask,
  discoverFilterCounts,
  discoverFindingsFor,
  discoverFixBrief,
  parseWorkflowLocation,
  workspaceLocation
} from './discover-run-text'
import { formatWorkflowElapsed, formatWorkflowTokens } from './local-workflow-labels'
import { workflowStages } from './workflow-run-stages'
import { workflowView } from './local-workflow-ui.fixtures'
import { councilRunView, discoverRunView, workflowCall } from './local-workflow-run.fixtures'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))

describe('workflow stage rail model', () => {
  it('names Council stages by position and shows what the running one is doing', () => {
    const stages = workflowStages(councilRunView())
    expect(stages.map((stage) => [stage.label, stage.tone])).toEqual([
      ['First opinions', 'running'],
      ['Peer rankings', 'running'],
      ["Chairman's answer", 'queued']
    ])
    expect(stages[0]).toMatchObject({ completed: 3, total: 4, failed: 0 })
    expect(stages[0].activeLine).toBe('Collecting individual responses…')
  })

  it('maps legacy Discover stage ids onto Find and Verify and folds cluster calls into Find', () => {
    const view = workflowView()
    view.preset = 'discover'
    view.stages = [
      { id: 'discover', label: 'Discover', completed: 1, total: 1, failed: 0 },
      { id: 'refute', label: 'Refute', completed: 0, total: 2, failed: 0 },
      { id: 'rank', label: 'Synthesize / Rank', completed: 0, failed: 0 }
    ]
    view.calls = [
      { ...view.calls[0], id: 'discover/Correctness', stageId: 'discover', state: 'completed' },
      { ...view.calls[0], id: 'cluster/0', stageId: 'cluster', state: 'running' }
    ]
    const stages = workflowStages(view)
    expect(stages.map((stage) => stage.label)).toEqual(['Find', 'Verify', 'Rank'])
    expect(stages[0].calls.map((call) => call.id)).toEqual(['discover/Correctness', 'cluster/0'])
    expect(stages[0].tone).toBe('running')
    expect(stages[1].tone).toBe('queued')
  })

  it('marks a stage whose every call failed, and a paused run amber', () => {
    const view = workflowView()
    view.state = 'failed'
    view.calls = [{ ...view.calls[0], state: 'failed', error: 'timed out' }]
    expect(workflowStages(view)[0].tone).toBe('failed')
    expect(workflowStages({ ...workflowView(), state: 'paused' })[0].tone).toBe('paused')
  })

  it('keeps a stage that started as started when the run is stopped or held', () => {
    const stopped = councilRunView()
    stopped.state = 'cancelled'
    stopped.calls = stopped.calls.map((call) =>
      call.state === 'running' ? { ...call, state: 'cancelled', live: undefined } : call
    )
    expect(workflowStages(stopped).map((stage) => stage.tone)).toEqual([
      'done',
      'stopped',
      'queued'
    ])
    const held = councilRunView()
    held.state = 'paused'
    held.calls = held.calls.filter((call) => call.state !== 'running')
    expect(workflowStages(held)[1].tone).toBe('paused')
    const failed = { ...stopped, state: 'failed' as const }
    failed.calls = [...stopped.calls, workflowCall('rank/seat-3', 'seat-3', { state: 'failed' })]
    expect(workflowStages(failed)[1].tone).toBe('failed')
  })

  it('treats an earlier stage as done once a later one started', () => {
    const view = discoverRunView()
    const stages = workflowStages(view)
    expect(stages.map((stage) => stage.tone)).toEqual(['done', 'done', 'done', 'done'])
    expect(stages[1]).toMatchObject({ failed: 1, completed: 3, total: 4 })
  })
})

describe('Council text', () => {
  it('replaces anonymous labels with bold model names and leaves unknown labels', () => {
    const run = councilRunView().councilRun!
    expect(
      deanonymizeCouncilText('Response B beats Response A; Response Z is new.', run.members)
    ).toBe('**GPT-5.6 Sol** beats **Claude Opus 5**; Response Z is new.')
  })

  it('maps lists after "Responses" and slashes, moves bold, and leaves bare letters alone', () => {
    const { members } = councilRunView().councilRun!
    expect(
      deanonymizeCouncilText('Responses A and C agree; Responses A, B, and D differ.', members)
    ).toBe(
      '**Claude Opus 5** and **Grok 4.6** agree; **Claude Opus 5**, **GPT-5.6 Sol**, and **Gemini 3.8 Flash** differ.'
    )
    expect(deanonymizeCouncilText('All of Response A/B/C/D flag it.', members)).toBe(
      'All of **Claude Opus 5**/**GPT-5.6 Sol**/**Grok 4.6**/**Gemini 3.8 Flash** flag it.'
    )
    expect(deanonymizeCouncilText("**Response A** wins; Response B's claim holds.", members)).toBe(
      "**Claude Opus 5** wins; **GPT-5.6 Sol**'s claim holds."
    )
    // Bare letters are not labels: "B's point", "A / B / C" stay as the model wrote them.
    expect(deanonymizeCouncilText("B's point and A / B / C", members)).toBe(
      "B's point and A / B / C"
    )
    expect(deanonymizeCouncilText('Response Z/A stays.', members)).toBe('Response Z/A stays.')
  })

  it('never maps part of a list: ranges and lists with an unknown label stay as written', () => {
    const { members } = councilRunView().councilRun!
    // Why: mapping only the first letter of "B–D" or "A and Z" named the wrong models.
    for (const text of [
      'Responses B–D agree.',
      'Responses A through C agree.',
      'Responses A, B–D agree.',
      'Responses A and Z agree.',
      'Response A/Z agrees.',
      'Response A–C agrees.',
      'Response A, B and C agree.'
    ]) {
      expect(deanonymizeCouncilText(text, members), text).toBe(text)
    }
    expect(deanonymizeCouncilText('Response A-level work and I agree.', members)).toBe(
      '**Claude Opus 5**-level work and I agree.'
    )
  })

  it("keeps the writer's bold around a whole phrase, with plain names inside it", () => {
    const { members } = councilRunView().councilRun!
    expect(deanonymizeCouncilText('**Response A is clearly strongest.**', members)).toBe(
      '**Claude Opus 5 is clearly strongest.**'
    )
    expect(deanonymizeCouncilText('**Responses A and C agree**, Response D not.', members)).toBe(
      '**Claude Opus 5 and Grok 4.6 agree**, **Gemini 3.8 Flash** not.'
    )
  })

  it('finds a voter call before and after its ballot lands', () => {
    const view = councilRunView()
    const run = view.councilRun!
    const stageCalls = view.calls.filter((call) => call.stageId === 'rank')
    expect(councilRankCall(view, run, stageCalls, 'seat-1')?.id).toBe('rank/seat-1')
    expect(councilRankCall(view, run, stageCalls, 'seat-2')?.id).toBe('rank/seat-2')
    expect(councilRankCall(view, run, stageCalls, 'seat-3')).toBeUndefined()
  })

  it('orders street cred by shared place and attaches the member', () => {
    const rows = councilStandingRows(councilRunView().councilRun!)
    expect(rows.map((row) => [row.place, row.member?.modelLabel, row.averageRank])).toEqual([
      [1, 'GPT-5.6 Sol', 1],
      [2, 'Gemini 3.8 Flash', 3]
    ])
  })
})

describe('Discover text', () => {
  it('filters findings by status and never lists merged repeats', () => {
    const findings = discoverRunView().discoverRun!.findings
    expect(discoverFilterCounts(findings)).toEqual({
      confirmed: 1,
      unverified: 0,
      refuted: 1,
      all: 2
    })
    expect(discoverFindingsFor(findings, 'all').map((finding) => finding.id)).toEqual(['f1', 'f2'])
    expect(discoverFindingsFor(findings, 'refuted').map((finding) => finding.id)).toEqual(['f2'])
  })

  it('parses file locations with and without line ranges', () => {
    expect(parseWorkflowLocation('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(parseWorkflowLocation('src/a.ts:12-20')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(parseWorkflowLocation('README.md')).toEqual({ path: 'README.md', line: null })
  })

  it('opens only workspace files, never paths an agent points outside it', () => {
    const root = '/Users/maintainer/shop/'
    expect(workspaceLocation('src/a.ts:12', root)).toEqual({ relativePath: 'src/a.ts', line: 12 })
    expect(workspaceLocation('./README.md', root)).toEqual({
      relativePath: 'README.md',
      line: null
    })
    expect(workspaceLocation('/Users/maintainer/shop/src/a.ts:3-9', root)).toEqual({
      relativePath: 'src/a.ts',
      line: 3
    })
    for (const outside of [
      '../../.ssh/id_rsa:1',
      '/etc/passwd',
      '/Users/maintainer/shop-other/a.ts',
      'src/../../x.ts',
      'C:/Windows/win.ini',
      'src\\a.ts',
      'src//a.ts',
      ''
    ]) {
      expect(workspaceLocation(outside, root)).toBeUndefined()
    }
    expect(workspaceLocation('src/a.ts', '')).toBeUndefined()
  })

  it('says what each finder and verifier works on', () => {
    const run = discoverRunView().discoverRun!
    expect(discoverCallTask({ id: 'find/r1/0/security' }, run)).toBe('Security · Checkout')
    expect(discoverCallTask({ id: 'verify/f1/reachability' }, run)).toBe(
      'Retry drops the idempotency key · Can it actually happen?'
    )
    expect(discoverCallTask({ id: 'find/r2/9/user-path' }, run)).toBe('User path')
    expect(discoverCallTask({ id: 'find/r1/repeats' }, run)).toBe(
      'Checking new findings for repeats'
    )
    expect(discoverCallTask({ id: 'scout/map' }, run)).toBeUndefined()
  })

  it('briefs Build + Review with the defect, where it is and the suggested fix', () => {
    const item = discoverRunView().discoverRun!.report!.items[0]
    const brief = discoverFixBrief(item, 'Find real bugs in the checkout flow')
    expect(brief.split('\n')[0]).toBe('Fix: Retry drops the idempotency key')
    expect(brief).toContain('Location: src/checkout/pay.ts:142')
    expect(brief).toContain('A timeout followed by a retry charges the card twice.')
    expect(brief).toContain('Reuse the original key on retry.')
    expect(brief).toContain(
      'Found by Discover while looking for: Find real bugs in the checkout flow'
    )
  })
})

describe('run formatting', () => {
  it('formats elapsed time and token counts compactly', () => {
    expect(formatWorkflowElapsed(12_400)).toBe('12s')
    expect(formatWorkflowElapsed(184_000)).toBe('3:04')
    expect(formatWorkflowElapsed(3_723_000)).toBe('1:02:03')
    expect(formatWorkflowTokens(812)).toBe('812')
    expect(formatWorkflowTokens(3_400)).toBe('3.4k')
    expect(formatWorkflowTokens(2_000_000)).toBe('2M')
    expect(workflowCall('answer/seat-1', 'seat-1').stageId).toBe('answer')
  })
})
