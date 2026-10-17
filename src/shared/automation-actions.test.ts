import { describe, expect, it } from 'vitest'
import { buildAutomationApplyPrompt, parseAutomationActions } from './automation-actions'

const action = { id: 'a1', kind: 'pause', label: 'Pause ad', nativeId: '123' }
const block = (entries: unknown) => `\`\`\`omni-actions\n${JSON.stringify(entries)}\n\`\`\``

describe('parseAutomationActions', () => {
  it('parses a clean block and builds an apply prompt', () => {
    const { actions, error } = parseAutomationActions(block([action]))
    expect(actions).toEqual([action])
    expect(error).toBeNull()
    expect(buildAutomationApplyPrompt(actions, 'base')).toBe(
      `APPLY:\n\`\`\`omni-actions\n${JSON.stringify([action], null, 2)}\n\`\`\`\n\nbase`
    )
  })
  it('parses wrapped and indented terminal output', () => {
    expect(
      parseAutomationActions(
        ' │ ```OMNI-ACTIONS   \n │ [{"id":"a1","kind":"pause",\n │ "label":"Pause ad","nativeId":"12\n │ 3"}]\n │ ```'
      ).actions
    ).toEqual([action])
  })
  it('finds the trailing fence after a trimmed, incomplete earlier block', () => {
    const content = `\`\`\`omni-actions\n[{"id":"cut\n\n[… output trimmed …]\n\nReport conclusion\n${block([action])}`
    expect(parseAutomationActions(content)).toEqual({ actions: [action], error: null })
  })
  it('returns no actions without a block', () => {
    expect(parseAutomationActions('Report')).toEqual({ actions: [], error: null })
  })
  it('drops invalid entries and lists their positions', () => {
    expect(parseAutomationActions(block([action, { id: 'bad' }]))).toEqual({
      actions: [action],
      error: 'Invalid omni-actions entries: 2.'
    })
  })
  it('uses the last block, including an empty array', () => {
    expect(parseAutomationActions(`${block([action])}\n${block([])}`)).toEqual({
      actions: [],
      error: null
    })
  })
})

describe('parseAutomationActions on soft-wrapped terminal JSON', () => {
  it('joins wrapped prose with a space and wrapped ids with nothing', () => {
    const wrapped = `\`\`\`omni-actions
[
  {
    "id": "a2",
    "kind": "pause",
    "label": "Pause WW Home WhoElse",
    "nativeId": "1202545452
    53600416",
    "name": "WW-ExUS-Sep20-DTC-LIFE399-SD25-Home-CBO300-5AS-OldACS — AS04-
    WhoElseWantsSeedance25",
    "reason": "WhoElse has 88 links, 2 registrations at $3.73 and 3 checkouts
    at $2.49."
  }
]
\`\`\``
    expect(parseAutomationActions(wrapped)).toEqual({
      actions: [
        {
          id: 'a2',
          kind: 'pause',
          label: 'Pause WW Home WhoElse',
          nativeId: '120254545253600416',
          name: 'WW-ExUS-Sep20-DTC-LIFE399-SD25-Home-CBO300-5AS-OldACS — AS04- WhoElseWantsSeedance25',
          reason: 'WhoElse has 88 links, 2 registrations at $3.73 and 3 checkouts at $2.49.'
        }
      ],
      error: null
    })
  })
  it('rejects a block whose JSON is still broken after joining', () => {
    expect(parseAutomationActions('```omni-actions\n[{"id": "a1",\n```')).toEqual({
      actions: [],
      error: 'Invalid omni-actions JSON.'
    })
  })
})
