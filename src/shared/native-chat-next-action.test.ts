import { describe, expect, it } from 'vitest'
import {
  currentParsedNextStepSuggestions,
  parsedNextStepSuggestionsFromText
} from './native-chat-next-action'
import type { NativeChatMessage } from './native-chat-types'
import { NEXT_STEP_SUGGESTION_MAX } from './next-step-suggestions'

const message = (id: string, role: 'user' | 'assistant', text: string): NativeChatMessage => ({
  id,
  role,
  timestamp: 1,
  source: 'transcript',
  blocks: [{ type: 'text', text }]
})
const titles = (text: string): string[] =>
  parsedNextStepSuggestionsFromText(text).map((suggestion) => suggestion.title)

describe('lists under a next-steps heading', () => {
  it('reads one suggestion per numbered item under a markdown heading', () => {
    expect(
      titles(
        'Done — the fix is in and tests pass.\n\n## Next steps\n1. Deploy the change to omni-dev\n2. Add a regression test for the empty-folder case\n3. Update the changelog'
      )
    ).toEqual([
      'Deploy the change to omni-dev',
      'Add a regression test for the empty-folder case',
      'Update the changelog'
    ])
  })

  it('reads bullets under a `Heading:` line', () => {
    expect(titles('Next steps:\n- Run the migration on staging\n- Review the PR')).toEqual([
      'Run the migration on staging',
      'Review the PR'
    ])
  })

  it.each([
    '**Suggested next steps**',
    '**Follow-ups:**',
    "### What's next",
    'Recommended next actions:',
    'Options:'
  ])('recognizes the heading %s', (heading) => {
    expect(titles(`${heading}\n\n- First thing\n- Second thing`)).toEqual([
      'First thing',
      'Second thing'
    ])
  })

  it('folds nested sub-bullets into their parent and ends at prose after a blank line', () => {
    const [first, ...rest] = parsedNextStepSuggestionsFromText(
      'Next steps:\n- Split the **store** module\n  - keep the public API\n  - move tests\n- Update [the docs](https://x.test)\n\nThat is all for now.\n\n- Not a suggestion'
    )
    expect(first).toMatchObject({
      title: 'Split the store module',
      prompt:
        'Please go ahead with this next step you suggested: Split the store module\n- keep the public API\n- move tests'
    })
    expect(rest.map((suggestion) => suggestion.title)).toEqual(['Update the docs'])
  })

  it('ends the list at a new heading', () => {
    expect(titles('## Next steps\n- Ship it\n## Notes\n- The cache is warm')).toEqual(['Ship it'])
  })

  it('marks risky steps and assigns deterministic ids and kinds', () => {
    expect(
      parsedNextStepSuggestionsFromText(
        'Next steps:\n1. Deploy the change to omni-dev\n2. Review the PR',
        'm1'
      )
    ).toEqual([
      {
        id: 'm1:0',
        title: 'Deploy the change to omni-dev',
        prompt: 'Please go ahead with this next step you suggested: Deploy the change to omni-dev',
        risk: 'risky',
        kind: 'ship'
      },
      {
        id: 'm1:1',
        title: 'Review the PR',
        prompt: 'Please go ahead with this next step you suggested: Review the PR',
        risk: 'safe',
        kind: 'review'
      }
    ])
  })

  it('keeps the first NEXT_STEP_SUGGESTION_MAX in document order', () => {
    const items = Array.from(
      { length: NEXT_STEP_SUGGESTION_MAX + 4 },
      (_, index) => `- Step number ${index + 1}`
    )
    const found = titles(`Next steps:\n${items.join('\n')}`)
    expect(found).toHaveLength(NEXT_STEP_SUGGESTION_MAX)
    expect(found[0]).toBe('Step number 1')
    expect(found.at(-1)).toBe(`Step number ${NEXT_STEP_SUGGESTION_MAX}`)
  })
})

describe('proposals in prose', () => {
  it('keeps a recommendation with a trailing clause, titled by what it recommends', () => {
    expect(titles('I recommend running the full test suite after the merge.')).toEqual([
      'Running the full test suite after the merge'
    ])
    expect(titles('I recommend we split this file; if you agree I can do it now.')).toEqual([
      'Split this file; if you agree I can do it now'
    ])
  })

  it.each([
    ['Would you like me to open a PR for this?', 'Open a PR for this'],
    ['Shall I rerun the build?', 'Rerun the build'],
    ['Should I add logging here?', 'Add logging here'],
    ['Want me to write the migration?', 'Write the migration'],
    ['Do you want me to update the docs?', 'Update the docs']
  ])('turns the offer %s into %s', (text, title) => {
    expect(titles(text)).toEqual([title])
  })

  it('keeps every recommendation in a run of sentences', () => {
    expect(
      titles(
        'I recommend fixing A. I recommend reviewing B. I recommend deploying C. I recommend implementing D.'
      )
    ).toEqual(['Fixing A', 'Reviewing B', 'Deploying C', 'Implementing D'])
  })

  it.each([
    ['I recommend giving this to another AI.', 'follow-up'],
    ['I recommend sending this to Uma.', 'follow-up'],
    ['I can fix this.', 'fix'],
    ['The durable solution is to fix bundled-skill refreshing.', 'fix'],
    ['The next step is to deploy.', 'ship'],
    ['I should continue with the remote browser.', 'continue'],
    ['This needs review.', 'review'],
    ['Would you like me to try again?', 'continue'],
    ['I recommend implementing the change.', 'continue'],
    ['Recommended next action:\n\n- Give this to another AI.', 'follow-up'],
    ['I recommend reviewing the change before we deploy.', 'review']
  ])('surfaces %s as %s', (text, kind) => {
    const found = parsedNextStepSuggestionsFromText(text)
    expect(found).toHaveLength(1)
    expect(found[0]!.kind).toBe(kind)
  })

  it.each([
    'I recommend we do not deploy yet.',
    'If the review passes, I can deploy.',
    'Once CI is green I recommend merging.',
    '> I recommend deploying.',
    '```\nI recommend deploying.\n```',
    'I already fixed this.',
    'The deployment is complete.',
    'I can see the file now.',
    `I recommend ${'x'.repeat(600)}.`
  ])('does not turn negations or non-proposals into suggestions: %s', (text) => {
    expect(titles(text)).toEqual([])
  })

  it('keeps separate proposals and unwraps the command they refer to', () => {
    expect(titles('I can fix `omni skills update`. I recommend reviewing the installer.')).toEqual([
      'I can fix omni skills update.',
      'Reviewing the installer'
    ])
  })

  it('dedupes by normalized text', () => {
    expect(titles('I recommend reviewing B.\n\nI recommend reviewing   b')).toEqual(['Reviewing B'])
  })
})

describe('each agent’s usual way of ending a turn', () => {
  it('reads a Codex closing "If you want, I can:" list', () => {
    expect(
      titles(
        'Implemented the loader fix in `src/loader.ts` and ran the focused tests (12 passed).\n\nIf you want, I can:\n- add tests for the empty case\n- open a PR'
      )
    ).toEqual(['Add tests for the empty case', 'Open a PR'])
  })

  it.each([
    ['If you want, I can also add a regression test.', ['Add a regression test']],
    ["If you'd like, I can open a PR next.", ['Open a PR next']],
    ['If helpful, I can profile the startup path.', ['Profile the startup path']],
    ['Next, I can wire the settings toggle.', ['Wire the settings toggle']],
    ['I can also add a regression test, or open a PR.', ['Add a regression test', 'Open a PR']],
    [
      'If you want, I can split the store; update the docs.',
      ['Split the store', 'Update the docs']
    ],
    ['If you want, I can add tests for A or B.', ['Add tests for A or B']]
  ])('turns the Codex offer %s into steps', (text, expected) => {
    expect(titles(text)).toEqual(expected)
  })

  it.each([
    'I can also:',
    'Possible next steps:',
    'Suggested follow-ups:',
    "If you'd like, I can:"
  ])('reads a list under %s', (heading) => {
    expect(titles(`${heading}\n1. Add logging\n2. Open a PR`)).toEqual(['Add logging', 'Open a PR'])
  })

  it('reads a Claude reply with a Next steps heading and a closing offer', () => {
    expect(
      titles(
        'Done — the fix is in.\n\n## Next steps\n1. Deploy the change to omni-dev\n2. Update the changelog\n\nWant me to open a PR for this?'
      )
    ).toEqual(['Deploy the change to omni-dev', 'Update the changelog', 'Open a PR for this'])
  })

  it.each([
    "If you want, I can't deploy from here.",
    'If you want, I can’t deploy from here.',
    'I already opened a PR, but if you want I can also add tests.',
    'If you want, I can do not-yet-safe things.',
    'If the review passes, I can deploy.',
    'If tests fail, I can fix them.'
  ])('still drops negations and real conditionals: %s', (text) => {
    expect(titles(text)).toEqual([])
  })
})

describe('round-2 review cases', () => {
  it('drops a list item that opens with a real condition and unwraps an offer opener', () => {
    expect(
      titles(
        "## Next steps\n- If the review passes, update the changelog\n- Once CI is green, merge\n- If you want, I can add a regression test\n- If you'd like, I can open a PR\n- Tidy the imports"
      )
    ).toEqual(['Add a regression test', 'Open a PR', 'Tidy the imports'])
  })

  it('drops a conditional inline next step', () => {
    expect(titles('Next step: if the review passes, deploy.')).toEqual([])
  })

  it.each([
    'I recommend not deploying.',
    'I suggest that we not merge this yet.',
    'I recommend you not rotate the key.',
    "I won't deploy this.",
    'We will not ship it today, I recommend waiting.'
  ])('drops a negated proposal: %s', (text) => {
    expect(titles(text)).toEqual([])
  })

  it.each([
    'I recommend adding a test so it does not regress.',
    'I recommend adding a test so it will not regress.',
    "I recommend adding a retry so it won't fail."
  ])('keeps a proposal whose "not" sits in a trailing clause: %s', (text) => {
    expect(titles(text)).toEqual([text.replace(/^I recommend a/, 'A').replace(/\.$/, '')])
  })
})

describe('noise from real replies (2026-09-24 evidence)', () => {
  it.each([
    'Next step: None needed.',
    '**Next steps:** None.',
    'Recommended next action: None required.',
    'Next steps:\n- No further changes.',
    '## Next steps\n1. No additional actions required.',
    'Follow-ups:\n- No follow-ups needed.',
    'Next step: Nothing else to do.',
    'Next steps:\n- Nothing further required.'
  ])('does not offer an explicit absence of next steps: %s', (text) => {
    expect(titles(text)).toEqual([])
    expect(currentParsedNextStepSuggestions([message('done', 'assistant', text)])).toBeNull()
  })

  it('drops a no-op item while retaining another actionable item', () => {
    expect(titles('Next steps:\n- None needed.\n- Review the release')).toEqual([
      'Review the release'
    ])
  })

  it.each([
    'No further changes; deploy now',
    'None needed for tests; review the release',
    'Nothing else required; send the report',
    'No additional actions required. Deploy now.'
  ])('retains an action after an apparent no-op prefix: %s', (text) => {
    expect(titles(`Next step: ${text}`)).toEqual([text])
  })

  it('retains an action in the nested details of an apparent no-op', () => {
    expect(
      parsedNextStepSuggestionsFromText('Next steps:\n- None needed.\n  - Deploy now')
    ).toMatchObject([
      {
        title: 'None needed.',
        prompt: 'Please go ahead with this next step you suggested: None needed.\n- Deploy now',
        risk: 'risky'
      }
    ])
  })

  it('never reads a markdown table row or separator as a step', () => {
    expect(
      titles(
        'Where each partner stands:\n\n| Partner | Status | Next step |\n| --- | --- | --- |\n| Acme | live | Renew the contract |'
      )
    ).toEqual([])
    expect(
      titles('## Next steps\n1. Put the hourly auto-sync back\n| Job | Next step |\n2. Not a step')
    ).toEqual(['Put the hourly auto-sync back'])
  })

  it('never reads a heading’s own text as a step', () => {
    expect(titles('## Next step: deploy the fix\n\nThe fix is in.')).toEqual([])
    expect(titles('### Recommendation\n\nThe fix is in.')).toEqual([])
  })

  it('skips a recommendation that describes rather than offers a step', () => {
    expect(
      titles(
        'So the rule I recommend is: use omnios for anything you review or share, and a Claude artifact only when a page needs other features.'
      )
    ).toEqual([])
  })

  it.each([
    [
      'My recommendation: leave the public release until you have 2 minutes for the Apple app-specific password.',
      'Leave the public release until you have 2 minutes for the Apple app-specific password'
    ],
    [
      'My recommendation is to turn off the job and archive those objectives.',
      'Turn off the job and archive those objectives'
    ],
    ['I recommend we put the hourly auto-sync back.', 'Put the hourly auto-sync back'],
    [
      "I'd suggest that you merge and deploy the two production PRs once their checks pass.",
      'Merge and deploy the two production PRs once their checks pass'
    ],
    ['For the fix, I recommend adding a guard to the loader.', 'Adding a guard to the loader']
  ])('titles %s by its actionable part', (text, title) => {
    expect(titles(text)).toEqual([title])
  })

  it('unwraps a leading recommendation in a list item and keeps the session’s own steps', () => {
    expect(
      titles(
        'Next steps:\n- My recommendation: leave it until Monday\n- Install main-next locally now so you get the IDE pieces'
      )
    ).toEqual(['Leave it until Monday', 'Install main-next locally now so you get the IDE pieces'])
  })
})

describe('what the session asked or offered (one-click answers)', () => {
  const offered = (text: string) =>
    parsedNextStepSuggestionsFromText(text).map((step) => [step.title, step.offered ?? false])

  it('marks a yes/no question as one offered step, never split', () => {
    expect(
      offered(
        'I rebuilt the three skills and found two wording problems.\n\nShould I make those two wording fixes, and save the rebuilt originals as backups next to the skills?'
      )
    ).toEqual([
      [
        'Make those two wording fixes, and save the rebuilt originals as backups next to the skills',
        true
      ]
    ])
  })

  it('marks every item under a Codex "If you want, I can:" or an Options heading', () => {
    expect(
      offered('Done.\n\nIf you want, I can:\n- add tests for the empty case\n- open a PR')
    ).toEqual([
      ['Add tests for the empty case', true],
      ['Open a PR', true]
    ])
    expect(offered('Options:\n1. Ship it now\n2. Wait for the review')).toEqual([
      ['Ship it now', true],
      ['Wait for the review', true]
    ])
  })

  it('leaves a plain next-steps list unmarked, and marks a listed step the reply then offers', () => {
    expect(offered('Next steps:\n1. Review the PR\n2. Update the changelog')).toEqual([
      ['Review the PR', false],
      ['Update the changelog', false]
    ])
    expect(
      offered('Next steps:\n1. Open a PR\n2. Update the changelog\n\nWant me to open a PR?')
    ).toEqual([
      ['Open a PR', true],
      ['Update the changelog', false]
    ])
  })
})

describe('the current reply', () => {
  it('expires suggestions when the user replies or the assistant replaces them', () => {
    const proposal = message('a', 'assistant', 'I can fix this.')
    expect(currentParsedNextStepSuggestions([proposal])).toMatchObject({
      messageId: 'a',
      suggestions: [{ id: 'a:0', kind: 'fix' }]
    })
    expect(currentParsedNextStepSuggestions([proposal, message('b', 'user', 'Wait')])).toBeNull()
    expect(
      currentParsedNextStepSuggestions([
        proposal,
        message('c', 'assistant', 'The work is complete.')
      ])
    ).toBeNull()
  })

  it('ignores recommendations inside provider frames', () => {
    const proposal = message('a', 'assistant', '')
    proposal.blocks = [
      {
        type: 'text',
        text: 'I recommend deploying.',
        providerFrame: { provider: 'codex', byteLength: 23 }
      } as never
    ]
    expect(currentParsedNextStepSuggestions([proposal])).toBeNull()
  })
})
