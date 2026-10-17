import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { screenedDiscover } from '../../../../shared/workflow-discover-screen.test-fixture'
import type { GraphCall } from './graph-plan'
import { drive, text } from './graph-test-harness'

// Taken on main-next 63da212eb, before evidence packs existed: a legacy run must never change.
const LEGACY_THOROUGH = 'b3cc3d2797fc9a2160a3ad1446e6b702a6b87d0c119b2ceaa9c1d921082eb34f'
const LEGACY_QUICK = '4f9445c093502af183c54ff59ae22f1cc489d896e2b453b08da80a9340435647'

/** Discover as a spec saved before `list.evidence`: the screened template with the option removed. */
function legacyDiscover(depth: 'quick' | 'thorough'): WorkflowSpec {
  const spec = screenedDiscover(['claude', 'codex', 'grok'], { depth })
  return {
    ...spec,
    steps: spec.steps.map((step) =>
      step.list ? { ...step, list: { maxItems: step.list.maxItems } } : step
    )
  }
}

const BRIEF = [
  '## Scope\nSCOPE: OK',
  '## Rubric\n- Is it real?\n- Is it specific?\n- Does it matter?',
  '## Severity\ncritical breaks everything.'
].join('\n\n')

const finding = (n: number, round: number) => ({
  title: `Defect ${n} in round ${round}`,
  detail: `A concrete failure scenario number ${n}: input ${n} leads to a wrong result.`,
  location: n % 3 ? `src/area/file${n}.ts:${n * 7}` : '',
  severity: (['critical', 'high', 'medium', 'low'] as const)[n % 4]
})

function answer(call: GraphCall): unknown {
  if (call.screen) {
    return {
      markdown: 'screened',
      scores: Object.fromEntries(
        call.screen.candidates.map((entry, index) => [entry.id, index === 1 ? 0.5 : 3])
      )
    }
  }
  if (call.stepId === 'brief') {
    return text(BRIEF)
  }
  if (call.stepId === 'scout') {
    return { items: [1, 2].map((n) => ({ ...finding(n, 0), title: `Area ${n}` })) }
  }
  if (call.stepId === 'find') {
    const round = call.round
    const seed = call.agentIndex + (call.itemKey?.endsWith('2') ? 3 : 0) + round * 10
    return { items: [finding(seed, round), finding(seed + 1, round)] }
  }
  if (call.id.endsWith('/impact')) {
    const keys = [...call.prompt.matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1]!)
    return {
      items: keys.map((key, index) => ({
        key,
        impact: (index % 5) + 1,
        why: `why ${index}`,
        sameAs: index === 3 ? keys[0]! : ''
      }))
    }
  }
  if (call.stepId === 'verify') {
    const verdict = call.agentIndex === 0 && call.itemKey?.endsWith('1') ? 'FAIL' : 'PASS'
    return text(`Checked ${call.itemKey}.\nVERDICT: ${verdict}`)
  }
  return text('The report.')
}

/** Every call's identity, prompt, schema and host request, hashed in plan order. */
function fingerprint(depth: 'quick' | 'thorough'): { hash: string; calls: number } {
  const plan = drive(legacyDiscover(depth), answer, { access: 'workspace-read' })
  expect(plan.outcome?.state).toBe('completed')
  const hash = createHash('sha256')
  for (const call of plan.calls) {
    const request = call.screen ?? call.facts ?? call.jev ?? call.check ?? null
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
        request && createHash('sha256').update(JSON.stringify(request)).digest('hex')
      ])
    )
  }
  hash.update(plan.outcome?.final?.markdown ?? '')
  return { hash: hash.digest('hex'), calls: plan.calls.length }
}

describe('a Discover spec without list.evidence replays byte for byte', () => {
  it('builds the same calls, prompts and request digests as before evidence packs (thorough)', () => {
    const result = fingerprint('thorough')
    expect(result.calls).toBeGreaterThan(20)
    expect(result.hash).toBe(LEGACY_THOROUGH)
  })

  it('builds the same calls, prompts and request digests as before evidence packs (quick)', () => {
    expect(fingerprint('quick').hash).toBe(LEGACY_QUICK)
  })
})
