import { describe, expect, it } from 'vitest'
import { nextStepReplyDecision } from './next-step-reply-decision'
import { parsedNextStepSuggestionsFromText } from './native-chat-next-action'
import { listOfferOf, offeredListCandidates, referencedNumbers } from './next-step-offered-list'
import {
  combinedNextStepOptionsPrompt,
  NEXT_STEP_OPTION_PROMPT_LEAD,
  NEXT_STEP_SUGGESTION_MAX
} from './next-step-suggestions'

// The reply that produced no next steps on Sal's Mac (2026-09-24), shortened but the same shape:
// a non-next-steps heading, ten bold-led numbered items, then an offer naming three of them in a
// clause followed by another clause that says "already".
const SLITE_MENU = [
  '## What else Slite should have for creative and advertising work',
  'From the catalog, the rules behind the ads are scattered. In priority order:',
  '',
  '1. **A "what we can say" sheet per brand.** Current prices and what each plan includes.',
  '2. **A landing-page register.** Which URL sells which product at which price.',
  '3. **An approved image and video library with sources.** Which demos are real outputs.',
  '4. **A Betacorp ad-launch guide and "top ads" page.** OmniRogue has both.',
  '5. **A tracking-link guide for humans.** The link-tagging rules.',
  '6. **A Meta ad-policy checklist.** The "unlimited" rules and AI disclosure.',
  '7. **A creative brief template for Betacorp.** Only an OmniRogue video brief exists.',
  '8. **A creative approval flow.** Who approves what, via which review page.',
  '9. **Brand kits for ACME and ApexLabs.**',
  '10. **A bank of angles and hooks per brand.** Tested angles with results.',
  '',
  "I can write items 1, 2 and 4 now; they come straight from sources I've already checked today."
].join('\n')

describe('a list the reply offers as a menu', () => {
  it('turns every item into an option of one group and pre-ticks the ones the offer names', () => {
    const steps = parsedNextStepSuggestionsFromText(SLITE_MENU, 'm1')

    expect(steps).toHaveLength(10)
    expect(steps.map((step) => step.title).slice(0, 3)).toEqual([
      'A "what we can say" sheet per brand',
      'A landing-page register',
      'An approved image and video library with sources'
    ])
    expect(steps.every((step) => step.offered && step.optionGroup === steps[0]!.optionGroup)).toBe(
      true
    )
    expect(steps.filter((step) => step.preselected).map((step) => step.title)).toEqual([
      'A "what we can say" sheet per brand',
      'A landing-page register',
      'A Betacorp ad-launch guide and "top ads" page'
    ])
    expect(steps[1]!.prompt).toBe(
      `${NEXT_STEP_OPTION_PROMPT_LEAD}A landing-page register\n- Which URL sells which product at which price.`
    )
  })

  it.each([
    ['Which of these should I start with?', []],
    ['Want me to do all of these?', [1, 2, 3]],
    ['Let me know which you want.', []],
    ['Shall I do #2 and #3?', [2, 3]],
    ["I'd start with items 1–2.", [1, 2]],
    ['Happy to take on any of them.', []]
  ])('reads the offer %j', (offer, preselected) => {
    const steps = parsedNextStepSuggestionsFromText(
      `Options I see:\n\n1. Add the audit log\n2. Split the store module\n3. Rename the tray\n\n${offer}`
    )
    expect(steps.map((step) => step.title)).toEqual([
      'Add the audit log',
      'Split the store module',
      'Rename the tray'
    ])
    expect(steps.flatMap((step, index) => (step.preselected ? [index + 1] : []))).toEqual(
      preselected
    )
  })

  it('keeps an item whose title says "already" or "never": the agent offered it by name', () => {
    const steps = parsedNextStepSuggestionsFromText(
      '1. Reuse the audience you already built\n2. Never publish the queue ladder\n\nWhich of these should I do?'
    )
    expect(steps.map((step) => step.title)).toEqual([
      'Reuse the audience you already built',
      'Never publish the queue ladder'
    ])
  })

  it('offers only the list the sentence follows, the last one', () => {
    const candidates = offeredListCandidates(
      'Changes:\n- Fixed the parser\n- Updated the docs\n\nIdeas:\n1. Add paging\n2. Add search\n\nWant me to do any of these?'
    )
    expect(candidates.map((candidate) => candidate.text)).toEqual(['Add paging', 'Add search'])
  })

  it('caps a long menu at the set maximum', () => {
    const items = Array.from(
      { length: 15 },
      (_, index) => `${index + 1}. Option number ${index + 1}`
    )
    const steps = parsedNextStepSuggestionsFromText(`${items.join('\n')}\n\nPick any of these.`)
    expect(steps).toHaveLength(NEXT_STEP_SUGGESTION_MAX)
  })
})

describe('what is not a menu', () => {
  it.each([
    ['a summary list with no offer', '1. Fixed the parser\n2. Updated the docs\n\nAll tests pass.'],
    [
      'a refusal in the offering clause',
      "1. Deploy it\n2. Merge it\n\nI can't do items 1 and 2 without your approval."
    ],
    [
      'a "which of these" that is not a question',
      '1. test_a\n2. test_b\n\nThe log shows which of these failed first.'
    ],
    ['a single item', '1. Deploy it\n\nWant me to do any of these?'],
    ['an offer before the list', 'Want me to do any of these?\n\n1. Deploy it\n2. Merge it']
  ])('ignores %s', (_label, text) => {
    expect(offeredListCandidates(text)).toEqual([])
  })

  it('leaves a "Next steps" list without an offer to the existing reader', () => {
    const steps = parsedNextStepSuggestionsFromText(
      '## Next steps\n1. Deploy the change to omni-dev\n2. Update the changelog'
    )
    expect(steps.map((step) => [step.title, step.optionGroup])).toEqual([
      ['Deploy the change to omni-dev', undefined],
      ['Update the changelog', undefined]
    ])
  })
})

describe('offer reading', () => {
  it('keeps all numbered choices when the reply asks for a number', () => {
    const text = [
      '1. **Close the 23 idle ones now** (frees about 7.2 GB). Recommended.',
      '2. Also close the 19 orphaned terminals after I check the remaining session first.',
      '3. Leave everything as it is.',
      '',
      'Reply 1, 2 or 3.'
    ].join('\n')
    const steps = parsedNextStepSuggestionsFromText(text)
    expect(steps.map((step) => step.title)).toEqual([
      'Close the 23 idle ones now',
      'Also close the 19 orphaned terminals after I check the remaining session first.',
      'Leave everything as it is.'
    ])
    expect(steps.every((step) => step.offered && step.optionGroup && !step.preselected)).toBe(true)
    expect(nextStepReplyDecision(text)).toBe('Reply 1, 2 or 3.')
  })

  it('only treats an explicit closing question as requiring an answer', () => {
    for (const question of [
      'Should I have an agent build OmniConsole and check the picker before the next install?',
      'Should I bring it down to something like $300/day while it proves itself?'
    ]) {
      expect(nextStepReplyDecision(`Work finished.\n\n${question}`)).toBe(question)
    }
    for (const text of [
      'If you want, I can run another check.',
      'I recommend checking the changelog.',
      '> Should I deploy this?',
      '```text\nShould I deploy this?\n```',
      '~~~text\nShould I deploy this?\n~~~',
      '    Should I deploy this?',
      'Example:\nShould I deploy this?',
      `\`\`\`text\n${'x'.repeat(24_000)}\nShould I deploy this?\n\`\`\``,
      'The old response asked: Should I deploy this?',
      'Should I deploy this?\n\nYou already answered; the deploy is complete.',
      'Reply 1, 2 or 3.'
    ]) {
      expect(nextStepReplyDecision(text)).toBeNull()
    }
  })
  it.each([
    ['1, 2 and 4', [1, 2, 4]],
    ['2–4', [2, 3, 4]],
    ['1 to 3 and 7', [1, 2, 3, 7]],
    ['#1 or #3', [1, 3]]
  ])('expands %j', (reference, numbers) => {
    expect(referencedNumbers(reference)).toEqual(numbers)
  })

  it('judges each clause on its own', () => {
    expect(listOfferOf("I can write items 1 and 2 now; I've already checked the sources.")).toEqual(
      {
        numbers: [1, 2],
        all: false
      }
    )
    expect(listOfferOf('I already wrote items 1 and 2.')).toBeNull()
  })
})

describe('several options sent together', () => {
  it("numbers them in order and keeps each option's details", () => {
    const [first, second] = parsedNextStepSuggestionsFromText(SLITE_MENU, 'm1')
    expect(combinedNextStepOptionsPrompt([first!, second!])).toBe(
      [
        'Please go ahead with these options you offered, together:',
        '1. A "what we can say" sheet per brand',
        '   - Current prices and what each plan includes.',
        '2. A landing-page register',
        '   - Which URL sells which product at which price.'
      ].join('\n')
    )
  })
})
