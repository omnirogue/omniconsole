import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { WorkflowCheck, WorkflowSpec } from '../../../../shared/workflow-graph'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import type { GraphCall, GraphConfig } from './graph-plan'
import { drive, text } from './graph-test-harness'

// Taken on main-next 329c51190, before Improve rules 2: a run admitted under rules 0 or 1 never changes.
const LEGACY: Record<string, string> = {
  'none/0': 'be655b43d508bb96d84f27380ba61b3686c3fc7691a6649882221fe006658f37',
  'none/1': 'de86c88647161a14604257bcbc5117253ad5c85af7be9190d8ed6dbab46a5669',
  'score/0': '39557a82316b58ca0a2cb1c57a86c259833caedd49785760664c018d1ccaa499',
  'score/1': '2fc2fd698c0dd3d48eaaf44be463e38e1c53e54c05aabec1d1a49871802ba2f3',
  'stop/0': '347a9af2f49582faaafd8f5b4d6d05eee9a1a1e2a353d1db82011853628edade',
  'stop/1': '4ad0422259e6c4355bfff77ec2431d8601c9376195846c719f3f1eab33b1ac16'
}

// What each scenario exercises: a divergent round, an unavailable check, #627's undecided stop.
const STOPS: Record<string, string> = {
  'none/0': 'max-rounds',
  'none/1': 'max-rounds',
  'score/0': 'max-rounds',
  'score/1': 'undecided',
  'stop/0': 'verified',
  'stop/1': 'verified'
}

/** An Improve spec as saved before rules 2: a literal, so template changes never move the pin. */
function saved(check?: WorkflowCheck): WorkflowSpec {
  return {
    version: 1,
    title: 'Improve',
    template: 'improve',
    steps: [
      {
        id: 'improve',
        kind: 'do',
        title: 'Improve',
        instruction: '',
        agents: [{ route: 'claude' }, { route: 'codex' }, { route: 'grok' }],
        inputs: []
      },
      {
        id: 'judge',
        kind: 'rank',
        title: 'Judge',
        instruction: '',
        agents: [{ route: 'codex' }],
        inputs: ['improve'],
        jev: { method: 'auto', only: true }
      }
    ],
    repeat: {
      do: 'improve',
      review: 'judge',
      until: 'plateau',
      maxRounds: 6,
      patience: 2,
      explore: 'normal',
      ...(check ? { check } : {})
    }
  }
}

// Per round, per improver: how good each version is to the judges, and what its check prints.
const QUALITY = [
  [1, 3, 2],
  [2, 1, 1],
  [5, 1, 3],
  [2, 6, 1],
  [1, 2, 3],
  [3, 1, 2]
]
const RESULTS: Record<string, string[][]> = {
  none: [],
  score: [
    ['fail', 'pass 5', 'fail'],
    ['pass 5', 'pass 7', 'lost'],
    ['pass 7', 'pass 7', 'fail'],
    ['fail', 'pass 9', 'pass 9'],
    ['pass 2', 'fail', 'pass 9'],
    ['pass 9', 'pass 9', 'pass 9']
  ],
  stop: [
    ['fail', 'fail', 'fail'],
    ['fail', 'fail', 'fail'],
    ['fail', 'fail', 'fail'],
    ['fail', 'pass', 'fail'],
    ['pass', 'pass', 'pass'],
    ['pass', 'pass', 'pass']
  ]
}

const quality = (markdown: string) => Number(/quality (\d+)/.exec(markdown)?.[1] ?? 0)

function answer(kind: string) {
  return (call: GraphCall): unknown => {
    if (call.check) {
      const [verdict, score] = (/RESULT: (.*)/.exec(call.check.candidate)?.[1] ?? '').split(' ')
      return verdict === 'lost'
        ? undefined
        : {
            markdown: 'check',
            passed: verdict === 'pass',
            ...(score ? { score: Number(score) } : {}),
            detail: `ran on round ${call.round} improver ${call.agentIndex}`
          }
    }
    if (call.jev) {
      const ordered = [...call.jev.candidates].sort(
        (left, right) => quality(right.markdown) - quality(left.markdown)
      )
      return {
        markdown: `FINAL RANKING:\n${ordered.map((entry, index) => `${index + 1}. ${entry.label}`).join('\n')}`,
        // Rounds 3 and 4 hand over to the model judge; in round 3 it fails, so nobody decides.
        ...(call.round === 3 || call.round === 4 ? { unsure: true } : {})
      }
    }
    if (call.stepId === 'judge') {
      if (call.round === 3) {
        return undefined
      }
      const labels = [...new Set(call.prompt.match(/Response [A-H]/g) ?? [])].toReversed()
      return text(
        `FINAL RANKING:\n${labels.map((label, index) => `${index + 1}. ${label}`).join('\n')}`
      )
    }
    const result = RESULTS[kind]![call.round - 1]?.[call.agentIndex] ?? 'fail'
    const score = QUALITY[call.round - 1]![call.agentIndex]!
    return text(
      `Version from round ${call.round} by improver ${call.agentIndex}, quality ${score}.\nRESULT: ${result}`
    )
  }
}

const CHECKS: Record<string, WorkflowCheck | undefined> = {
  none: undefined,
  score: { command: 'node bench.mjs {code}' },
  stop: { command: 'npm test', stopWhenPassing: true }
}
const RULES: Record<string, Partial<GraphConfig>> = { 0: {}, 1: { improveUnresolvedRounds: true } }

/** Every call's identity, prompt, schema, check request and output, then the trail and result. */
function fingerprint(
  kind: string,
  rules: string
): { hash: string; plan: ReturnType<typeof drive> } {
  const spec = saved(CHECKS[kind])
  const plan = drive(spec, answer(kind), { access: 'workspace-read', ...RULES[rules] })
  const hash = createHash('sha256')
  for (const call of plan.calls) {
    hash.update(
      JSON.stringify([
        call.id,
        call.seatId,
        call.stepId,
        call.round,
        call.itemKey ?? null,
        call.agentIndex,
        call.dependencies,
        call.prompt,
        call.schema,
        call.output ?? null,
        call.check ?? null,
        call.jev ?? null
      ])
    )
  }
  hash.update(JSON.stringify(plan.loop ?? null))
  hash.update(JSON.stringify(plan.outcome ?? null))
  return { hash: hash.digest('hex'), plan }
}

describe('an Improve run admitted before rules 2 replays byte for byte', () => {
  it('keeps the saved specs exactly as saved', () => {
    for (const check of Object.values(CHECKS)) {
      expect(normalizeWorkflowSpec(saved(check))).toEqual(saved(check))
    }
  })

  it.each(Object.keys(LEGACY))('builds the same plan as before (%s)', (key) => {
    const [kind, rules] = key.split('/') as [string, string]
    const { hash, plan } = fingerprint(kind, rules)
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.calls.length).toBeGreaterThan(6)
    expect(plan.loop?.status).toBe(STOPS[key])
    expect(hash).toBe(LEGACY[key])
  })
})
