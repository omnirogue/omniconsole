import { describe, expect, it } from 'vitest'
import { briefActorForFavorite } from './assisted-brief-actors'
import {
  applyBriefChallenge,
  chooseBriefReviewer,
  decideBriefFinding,
  recordBriefChallenge
} from './assisted-brief-challenge'
import { parseBriefChallenge, parseBriefDraft } from './assisted-brief-draft-parse'
import {
  buildBriefChallengePrompt,
  buildBriefDraftingPrompt
} from './assisted-brief-drafting-prompt'
import { createBriefRecord, currentBriefRevision } from './assisted-brief-revisions'
import type { AssistedBriefRecord, BriefActor } from './assisted-brief-types'

let counter = 0
const newId = () => `id${++counter}`
const CLAUDE: BriefActor = {
  agent: 'claude',
  model: 'claude-fable-5-1[1m]',
  label: 'Claude Teams · Fable'
}
const CODEX: BriefActor = {
  agent: 'codex',
  model: 'gpt-6-astra',
  effort: 'xhigh',
  label: 'Codex Team · Astra'
}
const RESEARCH_REQUEST =
  'Research how three competitors price their team plans and summarise it with gpt-6-astra.'

// Phrases that would invite the drafter to widen the work beyond the request.
const SCOPE_INVENTION = [
  'go beyond',
  'additional features',
  'nice to have',
  'expand the scope',
  'be creative',
  'anticipate',
  'add extra',
  'improve on the request'
]

function draftingPrompt(kind: 'git' | 'folder', request = RESEARCH_REQUEST): string {
  return buildBriefDraftingPrompt({
    request,
    attachments: [{ name: 'pricing.csv', path: '/notes/pricing.csv' }],
    namedModels: ['gpt-6-astra'],
    workspaceLabel: 'Market notes',
    workspaceKind: kind
  })
}

function researchRecord(): AssistedBriefRecord {
  const parsed = parseBriefDraft(
    JSON.stringify({
      outcome: { text: 'Summarise how three competitors price team plans', source: 'request' },
      scope: [{ text: 'Three competitors and their team plans', source: 'request' }],
      deliverables: [{ text: 'A comparison table', source: 'suggestion' }]
    }),
    { request: RESEARCH_REQUEST, namedModels: ['gpt-6-astra'], newId }
  )
  if (!parsed.ok) {
    throw new Error('draft did not parse')
  }
  return createBriefRecord({
    briefId: 'b2',
    workspaceKey: 'folder-1',
    original: { text: RESEARCH_REQUEST, attachments: [] },
    drafter: CLAUDE,
    content: parsed.content,
    now: 1_000
  })
}

describe('drafting prompt', () => {
  it('asks for a brief only, without inviting extra scope', () => {
    const prompt = draftingPrompt('git')
    expect(prompt).toContain('Do not do the work.')
    expect(prompt).toContain(
      'Do not add goals, features, deliverables or steps they did not ask for.'
    )
    expect(prompt).toContain('A simple request needs no questions.')
    for (const phrase of SCOPE_INVENTION) {
      expect(prompt.toLowerCase()).not.toContain(phrase)
    }
  })

  it('keeps the request, attachments and named models verbatim', () => {
    const prompt = draftingPrompt('git')
    expect(prompt).toContain(`<<<\n${RESEARCH_REQUEST}\n>>>`)
    expect(prompt).toContain('- pricing.csv: /notes/pricing.csv')
    expect(prompt).toContain('Models named in the request (keep exactly as written): gpt-6-astra')
    expect(prompt).toContain('do not propose other models')
  })

  it('makes no code assumption for folder, writing and research work', () => {
    const prompt = draftingPrompt(
      'folder',
      'Write a warm two-paragraph welcome note for new customers.'
    )
    expect(prompt).toContain('(a folder)')
    expect(prompt).not.toContain('Git repository')
    expect(prompt).toContain('Do not assume it involves code unless the request does.')
  })
})

describe('draft parsing', () => {
  it('credits a line to the person only when their words back it', () => {
    const reply = JSON.stringify({
      outcome: { text: 'Summarise competitor team pricing', source: 'request' },
      scope: [
        { text: 'Three competitors and their team plans', source: 'request' },
        { text: 'Build an interactive pricing dashboard', source: 'request' },
        { text: 'Summarise pricing with gpt-5.5', source: 'request' }
      ],
      assumptions: [{ text: 'Public list prices are enough', source: 'assumption' }]
    })
    const parsed = parseBriefDraft(`\`\`\`json\n${reply}\n\`\`\``, {
      request: RESEARCH_REQUEST,
      namedModels: ['gpt-6-astra'],
      newId
    })
    expect(parsed.ok).toBe(true)
    const content = parsed.ok ? parsed.content : null
    expect(content?.sections.scope.map((item) => item.origin)).toEqual([
      'request',
      'ai-suggestion',
      'ai-suggestion'
    ])
    expect(content?.sections.assumptions[0].origin).toBe('ai-assumption')
    expect(content?.questions).toEqual([])
  })

  it('bundles at most three questions with at most four choices', () => {
    const questions = Array.from({ length: 5 }, (_, index) => ({
      question: `Question ${index}?`,
      choices: ['a', 'b', 'c', 'd', 'e', 'a'],
      section: index === 0 ? 'nowhere' : 'deliverables'
    }))
    const parsed = parseBriefDraft(JSON.stringify({ outcome: 'Do it', questions }), {
      request: 'Do it',
      namedModels: [],
      newId
    })
    const content = parsed.ok ? parsed.content : null
    expect(content?.questions).toHaveLength(3)
    expect(content?.questions[0]).toMatchObject({
      choices: ['a', 'b', 'c', 'd'],
      section: 'constraints'
    })
  })

  it('rejects a reply without a usable outcome', () => {
    expect(
      parseBriefDraft('I could not draft this.', { request: 'x', namedModels: [], newId })
    ).toEqual({ ok: false })
  })
})

describe('independent challenge', () => {
  it('uses another agent than the drafter and maps findings to brief lines', () => {
    const record = researchRecord()
    expect(chooseBriefReviewer(CLAUDE, [CLAUDE, CODEX])).toBe(CODEX)
    expect(chooseBriefReviewer(CLAUDE, [CLAUDE])).toBeNull()
    const { prompt, lineIds } = buildBriefChallengePrompt(record)
    expect(prompt).toContain('missed requirements')
    expect(prompt).toContain('Do not propose new goals.')
    expect(prompt).toContain('[L2] Deliverables: A comparison table')
    const parsed = parseBriefChallenge(
      JSON.stringify({
        findings: [
          {
            kind: 'unnecessary-work',
            note: 'A table was not asked for',
            change: { action: 'remove', line: 'L2' }
          },
          {
            kind: 'missed-requirement',
            note: 'Name the model',
            change: { action: 'add', section: 'constraints', text: 'Summarise with gpt-6-astra' }
          },
          {
            kind: 'regression-risk',
            note: 'Unknown line',
            change: { action: 'remove', line: 'L9' }
          }
        ]
      }),
      { lineIds, newId }
    )
    expect(parsed.ok && parsed.findings.map((finding) => finding.change.action)).toEqual([
      'remove',
      'add',
      'none'
    ])
  })

  it('allows one review cycle and applies only accepted findings', () => {
    const record = researchRecord()
    const { lineIds } = buildBriefChallengePrompt(record)
    const parsed = parseBriefChallenge(
      JSON.stringify({
        findings: [
          {
            kind: 'unnecessary-work',
            note: 'Not asked for',
            change: { action: 'remove', line: 'L2' }
          },
          {
            kind: 'missed-requirement',
            note: 'Add a date',
            change: { action: 'add', section: 'scope', text: 'Prices as of this month' }
          }
        ]
      }),
      { lineIds, newId }
    )
    const findings = parsed.ok ? parsed.findings : []
    expect(recordBriefChallenge(record, { ...CLAUDE }, findings, 2_000)).toBe('same-model')
    const reviewed = recordBriefChallenge(record, CODEX, findings, 2_000)
    if (typeof reviewed === 'string') {
      throw new Error(reviewed)
    }
    expect(recordBriefChallenge(reviewed, CODEX, findings, 2_001)).toBe('cycle-used')
    const decided = decideBriefFinding(
      decideBriefFinding(reviewed, findings[0].id, 'accepted', 2_002),
      findings[1].id,
      'rejected',
      2_003
    )
    const applied = applyBriefChallenge(decided, { now: 3_000, newId })
    const revision = currentBriefRevision(applied)
    expect(revision.cause).toBe('challenge-applied')
    expect(revision.content.sections.deliverables).toEqual([])
    expect(revision.content.sections.scope.map((item) => item.text)).not.toContain(
      'Prices as of this month'
    )
    expect(applied.challenge?.status).toBe('applied')
  })
})

describe('drafting actors', () => {
  it('drafts with the favourite lead’s CLI and its exact model, never a team', () => {
    expect(
      briefActorForFavorite({
        id: 'claude-teams-fable',
        label: 'Claude Teams · Fable',
        agent: 'claude-agent-teams',
        model: 'claude-fable-5-1[1m]',
        team: 'claude-agent-teams',
        viewMode: 'chat'
      })
    ).toEqual({ agent: 'claude', model: 'claude-fable-5-1[1m]', label: 'Claude Teams · Fable' })
    expect(
      briefActorForFavorite({
        id: 'codex-team-astra',
        label: 'Codex Team · Astra',
        agent: 'codex',
        model: 'gpt-6-astra',
        effort: 'xhigh',
        team: 'codex-subagents',
        viewMode: 'chat'
      })
    ).toEqual(CODEX)
    expect(
      briefActorForFavorite({ id: 'grok', label: 'Grok', agent: 'grok', viewMode: 'terminal' })
    ).toBeNull()
  })
})
