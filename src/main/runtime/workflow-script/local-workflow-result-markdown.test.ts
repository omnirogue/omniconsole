import { describe, expect, it } from 'vitest'
import { localWorkflowResultMarkdown } from './local-workflow-result-markdown'

describe('an agent answer as the run view shows it', () => {
  it('keeps a text answer as written', () => {
    expect(localWorkflowResultMarkdown({ markdown: '## Plan\n\nShip it.' })).toBe(
      '## Plan\n\nShip it.'
    )
  })

  it('shows a list answer as numbered findings, never raw JSON', () => {
    // Why: Find agents' answers showed on screen as a JSON object with escaped newlines.
    const shown = localWorkflowResultMarkdown({
      items: [
        {
          title: '`route` decides on the cached capacity snapshot',
          detail:
            'TRIGGER: any `route --task implement`.\n\n```python\ncap = _json(["capacity"])\n```',
          location: 'autonomy/bin/route:160',
          severity: 'high'
        },
        {
          title: 'Audit misses dispatching packets',
          detail: 'FIX: scan both.',
          location: '',
          severity: 'medium'
        }
      ]
    })
    expect(shown).toBe(
      [
        '#### 1. `route` decides on the cached capacity snapshot',
        '**high** · `autonomy/bin/route:160`',
        'TRIGGER: any `route --task implement`.\n\n```python\ncap = _json(["capacity"])\n```',
        '---',
        '#### 2. Audit misses dispatching packets',
        '**medium**',
        'FIX: scan both.'
      ].join('\n\n')
    )
    expect(shown).not.toContain('"items"')
  })

  it('says so when a list answer is empty, and keeps JSON only for shapes it does not know', () => {
    expect(localWorkflowResultMarkdown({ items: [] })).toBe('_Nothing to report._')
    expect(localWorkflowResultMarkdown({ ranking: ['A', 'B'] })).toBe(
      '```json\n{\n  "ranking": [\n    "A",\n    "B"\n  ]\n}\n```'
    )
  })
})
