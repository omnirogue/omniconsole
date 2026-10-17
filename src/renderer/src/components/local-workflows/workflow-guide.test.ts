import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en.json'
import { workflowGuide } from './workflow-guide'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { workflowPresetDescription, type WorkflowKind } from './workflow-presets'

const KINDS: WorkflowKind[] = [
  'audit',
  'discover',
  'council',
  'improve',
  'find',
  'best-of-n',
  'build-review',
  'custom',
  'decide',
  'investigate'
]
// Words a person new to AI would not know; the guide and the menu line must do without them.
const JARGON =
  /\b(JEV|lineage|escalat\w*|synthes\w*|graph|blind|chairman|verif\w*|scout|rubric|model family)\b/i

function lookup(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      en
    )
}

describe('the plain-language workflow guide', () => {
  it('explains every workflow: what it does, when to use it, what happens and what you get', () => {
    for (const kind of KINDS) {
      const guide = workflowGuide(kind)
      expect(guide.what.length, kind).toBeGreaterThan(40)
      expect(guide.useWhen.length, kind).toBeGreaterThanOrEqual(2)
      expect(guide.steps.length, kind).toBeGreaterThanOrEqual(3)
      expect(guide.youGet.length, kind).toBeGreaterThan(20)
    }
  })

  it('uses no AI jargon in the guide or the menu line', () => {
    for (const kind of KINDS) {
      const guide = workflowGuide(kind)
      const text = [guide.what, ...guide.useWhen, ...guide.steps, guide.youGet, guide.time ?? '']
      for (const line of [...text, workflowPresetDescription(kind)]) {
        expect(line, `${kind}: ${line}`).not.toMatch(JARGON)
      }
    }
  })

  it('gives a time only where a run was measured, and says it was a test', () => {
    expect(KINDS.filter((kind) => workflowGuide(kind).time)).toEqual(['discover', 'council'])
    for (const kind of KINDS) {
      const time = workflowGuide(kind).time
      expect(time === undefined || time.endsWith('in our tests.'), kind).toBe(true)
    }
  })

  // The catalog wins over a translate() fallback, so a new or changed line shows only when
  // en.json says the same thing.
  it('has every guide and menu line in the English catalog, word for word', () => {
    const source = [
      'workflow-guide.ts',
      'workflow-guide-audit.ts',
      'workflow-guide-decide.ts',
      'workflow-guide-investigate.ts',
      'WorkflowGuideCard.tsx',
      'workflow-presets.tsx'
    ]
      .map((file) => readFileSync(join(__dirname, file), 'utf8'))
      .join('\n')
    const pairs = [
      ...source.matchAll(
        /translate\(\s*'(localWorkflow\.(?:guide|preset)\.[^']+)',\s*'((?:[^'\\]|\\.)*)'/g
      )
    ]
    expect(pairs.length).toBeGreaterThan(60)
    for (const [, key, fallback] of pairs) {
      expect(lookup(key!), key).toBe(fallback)
    }
  })

  it('gives Decide the most AI calls from its real call bound, and no untested time', () => {
    const calls = planWorkflowCalls(workflowTemplate('decide')).agentTotal
    expect(workflowGuide('decide').youGet).toContain(`at most ${calls} AI calls`)
    expect(workflowGuide('decide').time).toBeUndefined()
  })

  it('gives Investigate the most AI calls from its real call bound, and no untested time', () => {
    const calls = planWorkflowCalls(workflowTemplate('investigate')).agentTotal
    expect(workflowGuide('investigate').youGet).toContain(`at most ${calls} AI calls`)
    expect(workflowGuide('investigate').time).toBeUndefined()
  })
})
