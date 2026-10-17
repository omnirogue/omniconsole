import { describe, expect, it } from 'vitest'
import {
  JEV_RUBRIC_MAX_INPUT_BYTES,
  JEV_RUBRIC_RESPONSE_MAX_CHARS,
  jevRubricEvaluationSchema,
  jevRubricSaveSchema,
  resolveJevRubric,
  saveJevLibraryRubric
} from './jev-rubrics'
import { REVIEW_RUBRIC_MAX_CHARS, SAVED_REVIEW_RUBRICS_MAX } from './review-rubrics'
import { rubricLibrary } from './rubric-library'

const rubric = {
  name: 'Our support',
  instructions: '- Correct facts\n- Clear next step',
  kind: 'reply' as const
}
const input = { rubric: rubric.name, task: 'Judge this reply', response: 'Here is the next step.' }

describe('agent rubric inputs', () => {
  it('keeps custom domain rubrics and defaults to explicit non-replacement', () => {
    expect(jevRubricSaveSchema.parse({ rubric })).toEqual({ rubric, replace: false })
    expect(jevRubricEvaluationSchema.parse({ input }).control).toBe('request')
  })

  it('rejects unknown fields, invalid kinds, blank and oversized rubric data', () => {
    for (const invalid of [
      { rubric, apiKey: 'key' },
      { rubric: { ...rubric, actions: ['send'] } },
      { rubric: { ...rubric, kind: 'unknown' } },
      { rubric: { ...rubric, name: ' ' } },
      { rubric: { ...rubric, name: 'x'.repeat(81) } },
      { rubric: { ...rubric, instructions: 'x'.repeat(REVIEW_RUBRIC_MAX_CHARS + 1) } }
    ]) {
      expect(jevRubricSaveSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('preserves the complete response and rejects total UTF-8 or escaped-JSON overflow', () => {
    const response = '  Exact response.\n'
    expect(jevRubricEvaluationSchema.parse({ input: { ...input, response } }).input.response).toBe(
      response
    )
    for (const response of [
      'x'.repeat(JEV_RUBRIC_RESPONSE_MAX_CHARS + 1),
      '語'.repeat(17000),
      '"'.repeat(26000)
    ]) {
      const candidate = { ...input, response }
      if (response.length <= JEV_RUBRIC_RESPONSE_MAX_CHARS) {
        expect(new TextEncoder().encode(JSON.stringify(candidate)).byteLength).toBeGreaterThan(
          JEV_RUBRIC_MAX_INPUT_BYTES
        )
      }
      expect(jevRubricEvaluationSchema.safeParse({ input: candidate }).success).toBe(false)
    }
  })

  it('bounds every evidence field and rejects action or provider overrides', () => {
    for (const invalid of [
      { input: { ...input, response: '  ' } },
      { input: { ...input, task: 'x'.repeat(6001) } },
      { input: { ...input, evidence: { status: 'approved', text: 'facts' } } },
      { input: { ...input, evidence: { status: 'verified', text: 'x'.repeat(6001) } } },
      {
        input: { ...input, evidence: { status: 'verified', text: 'facts', actionAuthorized: true } }
      },
      { input: { ...input, questions: {} } },
      { input, model: 'another-model' },
      { input, control: 'override' }
    ]) {
      expect(jevRubricEvaluationSchema.safeParse(invalid).success).toBe(false)
    }
  })
})

describe('one host rubric library', () => {
  it('resolves every kind by name or stable value, and freezes a separate admitted copy', () => {
    const library = rubricLibrary([rubric])
    const entry = resolveJevRubric(library, 'OUR SUPPORT')
    expect(entry).toMatchObject({ value: 'saved:Our support', kind: 'reply', builtIn: false })
    expect(resolveJevRubric(library, 'library:ad-copy').kind).toBe('ads')
    expect(resolveJevRubric(library, 'GitHub repository').kind).toBe('repo')
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry.rubric)).toBe(true)
    library.at(-1)!.rubric.instructions = 'Changed after admission'
    expect(entry.rubric.instructions).toBe(rubric.instructions)
  })

  it('refuses missing or ambiguous names instead of choosing a different rubric', () => {
    const library = rubricLibrary([{ name: 'Ad copy', instructions: 'Legacy custom rubric' }])
    expect(() => resolveJevRubric(library, 'Ad copy')).toThrow('ambiguous')
    expect(() => resolveJevRubric(library, 'missing')).toThrow('not found')
    expect(resolveJevRubric(library, 'saved:Ad copy').builtIn).toBe(false)
    expect(resolveJevRubric(library, 'library:ad-copy').builtIn).toBe(true)
  })

  it('requires explicit replacement, protects built-ins, and preserves unrelated saves', () => {
    const current = [{ name: 'Other', instructions: 'Keep it' }, rubric]
    const replacement = { ...rubric, name: 'OUR SUPPORT', instructions: 'New criteria' }
    expect(() => saveJevLibraryRubric(current, replacement)).toThrow('replace')
    expect(saveJevLibraryRubric(current, replacement, true)).toEqual([current[0], replacement])
    for (const name of ['general', 'Ad copy', 'library:ad-copy']) {
      expect(() => saveJevLibraryRubric(current, { ...rubric, name }, true)).toThrow('Built-in')
    }
    expect(current[1]).toEqual(rubric)
  })

  it('rejects overflow without evicting existing rubrics; replacement still works at capacity', () => {
    const current = Array.from({ length: SAVED_REVIEW_RUBRICS_MAX }, (_, index) => ({
      name: `Saved ${index}`,
      instructions: 'Existing rubric'
    }))
    expect(() => saveJevLibraryRubric(current, rubric)).toThrow('limit')
    const next = saveJevLibraryRubric(current, { name: 'Saved 0', instructions: 'Updated' }, true)
    expect(next).toHaveLength(SAVED_REVIEW_RUBRICS_MAX)
    expect(next.slice(0, -1)).toEqual(current.slice(1))
  })
})
