import { describe, expect, it } from 'vitest'
import {
  DECISION_MAX_INPUT_BYTES,
  snapshotDecisionRequest
} from '../../src/shared/structured-decisions.ts'
import { AGENT_TURN_FAILURE_REASON_MAX_LENGTH } from '../../src/shared/agent-turn-failure.ts'
import { EVALUATION_CASES } from './typesafe-evaluation-corpus.mjs'

const tasks = ['error_triage', 'evidence_support', 'context_relevance']
const splits = ['development', 'holdout']
const stateKeys = {
  error_triage: ['reason'],
  evidence_support: ['claim', 'source'],
  context_relevance: ['document', 'query']
}

describe('authored synthetic evaluation corpus', () => {
  it('contains 48 unique authored cases with fixed task and split counts', () => {
    expect(EVALUATION_CASES).toHaveLength(48)
    expect(new Set(EVALUATION_CASES.map(({ id }) => id)).size).toBe(48)
    expect(new Set(EVALUATION_CASES.map(({ state }) => JSON.stringify(state))).size).toBe(48)
    for (const task of tasks) {
      const cases = EVALUATION_CASES.filter((item) => item.task === task)
      expect(cases).toHaveLength(16)
      expect(cases.filter((item) => item.split === 'development')).toHaveLength(4)
      expect(cases.filter((item) => item.split === 'holdout')).toHaveLength(12)
    }
    for (const item of EVALUATION_CASES) {
      expect(item.origin).toBe('authored_synthetic')
      expect(tasks).toContain(item.task)
      expect(splits).toContain(item.split)
      expect(item.id).toMatch(/^[a-z0-9-]+$/)
      expect(item.familyId).toMatch(/^[a-z0-9-]+$/)
      expect(item.rationale.trim().length).toBeGreaterThan(20)
    }
  })

  it('keeps paraphrase families within a single task and split', () => {
    const families = new Map()
    for (const item of EVALUATION_CASES) {
      const family = families.get(item.familyId) ?? []
      family.push(item)
      families.set(item.familyId, family)
    }
    expect([...families.values()].filter((family) => family.length > 1).length).toBeGreaterThan(0)
    for (const family of families.values()) {
      expect(new Set(family.map(({ split }) => split)).size).toBe(1)
      expect(new Set(family.map(({ task }) => task)).size).toBe(1)
      expect(new Set(family.map(({ expected }) => JSON.stringify(expected))).size).toBe(1)
    }
  })

  it.each(EVALUATION_CASES)('validates a bounded model input without labels for $id', (item) => {
    expect(Object.getPrototypeOf(item.state)).toBe(Object.prototype)
    expect(Object.keys(item.state).sort()).toEqual(stateKeys[item.task])
    expect(Object.values(item.state).every((value) => typeof value === 'string')).toBe(true)
    const request = {
      capability: `evaluation.${item.task}`,
      state: item.state,
      questions: item.questions
    }
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(8 * 1024)
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(DECISION_MAX_INPUT_BYTES)
    const snapshot = snapshotDecisionRequest(request)
    expect(snapshot).toEqual(request)
    expect(Object.keys(snapshot).sort()).toEqual(['capability', 'questions', 'state'])
    expect(Object.isFrozen(snapshot.state)).toBe(true)
    expect(Object.keys(item.expected).sort()).toEqual(Object.keys(item.questions).sort())
  })

  it('uses admissible labels, finite numeric bounds and predeclared tolerances', () => {
    for (const item of EVALUATION_CASES) {
      for (const [id, question] of Object.entries(item.questions)) {
        const expected = item.expected[id]
        expect(Object.keys(expected).every((key) => ['value', 'tolerance'].includes(key))).toBe(
          true
        )
        if (question.type === 'choice') {
          expect(Object.keys(question.criteria)).toContain(expected.value)
          expect(expected.tolerance).toBeUndefined()
        } else {
          expect(Number.isFinite(expected.value)).toBe(true)
          expect(expected.value).toBeGreaterThanOrEqual(0)
          expect(expected.value).toBeLessThanOrEqual(question.type === 'noul' ? 1 : 3)
          expect(expected.tolerance).toBe(question.type === 'noul' ? 0.2 : 0.5)
        }
      }
      if (item.task === 'error_triage') {
        expect(Object.keys(item.questions)).toEqual(['decision'])
        expect(item.questions.decision.type).toBe('choice')
        expect(Object.keys(item.questions.decision.criteria)).toEqual([
          'usage-limit',
          'authentication',
          'unknown'
        ])
        expect(item.state.reason.length).toBeLessThanOrEqual(AGENT_TURN_FAILURE_REASON_MAX_LENGTH)
      }
      if (item.task === 'evidence_support') {
        expect(Object.keys(item.questions)).toEqual(['decision', 'supported'])
        expect(item.questions.decision.type).toBe('choice')
        expect(item.questions.supported.type).toBe('noul')
        expect(item.expected.supported.value).toBe(
          item.expected.decision.value === 'supports' ? 1 : 0
        )
      }
      if (item.task === 'context_relevance') {
        expect(Object.keys(item.questions)).toEqual(['relevance'])
        expect(item.questions.relevance.type).toBe('score')
        expect(item.questions.relevance.criteria).toHaveLength(4)
        expect(Number.isInteger(item.expected.relevance.value)).toBe(true)
      }
    }
  })

  it('covers every rubric class in development and holdout', () => {
    for (const split of splits) {
      const cases = EVALUATION_CASES.filter((item) => item.split === split)
      const labels = (task, id) =>
        [
          ...new Set(
            cases.filter((item) => item.task === task).map((item) => item.expected[id].value)
          )
        ].sort()
      expect(labels('error_triage', 'decision')).toEqual([
        'authentication',
        'unknown',
        'usage-limit'
      ])
      expect(labels('evidence_support', 'decision')).toEqual([
        'absent',
        'contradicts',
        'partial',
        'supports'
      ])
      expect(labels('context_relevance', 'relevance')).toEqual([0, 1, 2, 3])
    }
  })
})
