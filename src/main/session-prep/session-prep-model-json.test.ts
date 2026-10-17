import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { extractJsonObject, parseModelJson, preparedFieldsSchema } from './session-prep-model-json'

describe('extractJsonObject', () => {
  it('reads the first object through fences and prose', () => {
    const raw = 'Sure.\n```json\n{"title":"A","ok":true}\n```\nthanks'
    expect(extractJsonObject(raw)).toEqual({ title: 'A', ok: true })
  })

  it('ignores braces in trailing prose and inside strings', () => {
    expect(extractJsonObject('{"a":{"b":1}} and {not json}')).toEqual({ a: { b: 1 } })
    expect(extractJsonObject('{"t":"use } here"}')).toEqual({ t: 'use } here' })
  })

  it('skips prose braces before the object, closed or not', () => {
    expect(extractJsonObject('Fill {TBD} then {"a":1}')).toEqual({ a: 1 })
    expect(extractJsonObject('x {oops {"a":1}')).toEqual({ a: 1 })
  })

  it('returns null when there is no object', () => {
    expect(extractJsonObject('no json here')).toBeNull()
  })
})

describe('parseModelJson', () => {
  it('validates prepared fields and trims strings', () => {
    const raw = JSON.stringify({
      title: '  Login  ',
      outcome: ' Users can sign in. ',
      doneWhen: [' test passes ', '', ' screen shows home '],
      decided: ['Use existing auth'],
      references: [{ path: ' src/auth.ts ', why: ' login handler ' }],
      constraints: [],
      assumptions: ['  keep current copy  '],
      blockingQuestion: null,
      changesCode: true
    })
    const parsed = parseModelJson(raw, preparedFieldsSchema)
    expect(parsed).toMatchObject({
      title: 'Login',
      outcome: 'Users can sign in.',
      doneWhen: ['test passes', 'screen shows home'],
      assumptions: ['keep current copy'],
      blockingQuestion: null
    })
  })

  it('keeps a named repository and drops an empty one', () => {
    const base = {
      title: 'T',
      outcome: 'O',
      doneWhen: ['a', 'b'],
      decided: [],
      references: [],
      constraints: [],
      assumptions: [],
      changesCode: true
    }
    expect(
      parseModelJson(JSON.stringify({ ...base, repo: ' omnirogue ' }), preparedFieldsSchema)?.repo
    ).toBe('omnirogue')
    expect(
      parseModelJson(JSON.stringify({ ...base, repo: null }), preparedFieldsSchema)
    ).not.toHaveProperty('repo', expect.anything())
  })

  it('rejects a mismatched schema', () => {
    expect(parseModelJson('{"items":1}', z.object({ items: z.array(z.string()) }))).toBeNull()
  })

  it('keeps a recommended effort level', () => {
    const raw = JSON.stringify({
      title: 'Docs',
      outcome: 'Docs updated.',
      doneWhen: ['a', 'b'],
      decided: [],
      references: [],
      constraints: [],
      assumptions: [],
      blockingQuestion: null,
      changesCode: false,
      effort: 'low'
    })
    expect(parseModelJson(raw, preparedFieldsSchema)?.effort).toBe('low')
  })
})
