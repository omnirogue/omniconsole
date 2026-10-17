import { describe, expect, it } from 'vitest'
import {
  extractWorkflowScriptMetaSource,
  readWorkflowScriptMeta,
  workflowScriptBody
} from './workflow-script-sandbox'

describe('readWorkflowScriptMeta', () => {
  it('reads a pure literal with nested strings that contain braces', () => {
    const meta = readWorkflowScriptMeta(`export const meta = {
      name: 'review-verify',
      description: "Review } then { verify",
      whenToUse: \`pre-merge\`,
      phases: [{ title: 'Review', detail: 'one per dimension' }, { title: 'Verify' }],
    }
    phase('Review')`)
    expect(meta).toEqual({
      name: 'review-verify',
      description: 'Review } then { verify',
      whenToUse: 'pre-merge',
      phases: [{ title: 'Review', detail: 'one per dimension' }, { title: 'Verify' }]
    })
  })

  it('refuses a missing literal, a computed literal and a bad name', () => {
    expect(() => readWorkflowScriptMeta('const x = 1')).toThrow('no `export const meta')
    expect(() =>
      readWorkflowScriptMeta("const n = 'a'\nexport const meta = { name: n, description: 'd' }")
    ).toThrow('not a pure literal')
    expect(() =>
      readWorkflowScriptMeta("export const meta = { name: 'Bad Name', description: 'd' }")
    ).toThrow('lowercase')
    expect(() =>
      readWorkflowScriptMeta("export const meta = { name: 'ok', phases: [{}] }")
    ).toThrow('description')
  })

  it('parses meta as data and never runs anything in it', () => {
    // Each of these would run code if the literal were evaluated; parsing refuses them all.
    const attacks = [
      "{ name: (async () => { while (true) {} })(), description: 'd' }",
      "{ name: 'x', description: this.constructor.constructor('return process')() }",
      "{ name: 'x', description: `${globalThis}` }",
      "{ name: 'x', description: 'd', get phases() { return [] } }",
      "{ name: 'x', description: 'd', ...{ phases: [] } }",
      "{ ['name']: 'x', description: 'd' }",
      "{ name: 'x', description: 'd', __proto__: { polluted: true } }"
    ]
    for (const literal of attacks) {
      expect(() => readWorkflowScriptMeta(`export const meta = ${literal}`)).toThrow(
        'not a pure literal'
      )
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('accepts comments, trailing commas, escapes and backtick strings', () => {
    const meta = readWorkflowScriptMeta(`export const meta = {
      // the workflow's name
      name: "review-it", /* block */ description: \`Review "x" and 'y'\`,
      whenToUse: 'line\\none',
      phases: [{ title: 'Find', detail: 'a\\u0041', }, { title: 'Verify', },],
    }`)
    expect(meta).toEqual({
      name: 'review-it',
      description: `Review "x" and 'y'`,
      whenToUse: 'line\none',
      phases: [{ title: 'Find', detail: 'aA' }, { title: 'Verify' }]
    })
  })

  it('reads what JavaScript reads: continuations, code points, every line break', () => {
    const read = (literal: string) => readWorkflowScriptMeta(`export const meta = ${literal}`)
    expect(read("{name:'x',description:'a\\\r\nb'}").description).toBe('ab')
    expect(read("{name:'x',description:'Ship \\u{1F680}'}").description).toBe('Ship 🚀')
    // Code-point escapes may be zero-padded past six digits.
    expect(read("{name:'x',description:'\\u{0000061}'}").description).toBe('a')
    expect(read("{name:'x', // it's\rdescription:'d'}").description).toBe('d')
    expect(read("{name:'x', // it's\u2028description:'d'}").description).toBe('d')
    expect(read("{name:'x',description:`a\r\nb`}").description).toBe('a\nb')
    expect(
      readWorkflowScriptMeta("export const meta = /* the meta */ {name:'x',description:'d'}").name
    ).toBe('x')
    expect(
      readWorkflowScriptMeta("export const meta = // the meta\n{name:'x',description:'d'}").name
    ).toBe('x')
    expect(() => read("{name:'x',description:'\\u{110000}'}")).toThrow('not a pure literal')
    expect(() => read("{name:'x',description:'\\u{00000110000}'}")).toThrow('not a pure literal')
  })

  it('extracts the literal source and rewrites the export for the body', () => {
    const source = "export const meta = { name: 'x', description: 'y' }\nreturn 1"
    expect(extractWorkflowScriptMetaSource(source)).toBe("{ name: 'x', description: 'y' }")
    expect(workflowScriptBody(source)).toBe(
      "const meta = { name: 'x', description: 'y' }\nreturn 1"
    )
  })
})
