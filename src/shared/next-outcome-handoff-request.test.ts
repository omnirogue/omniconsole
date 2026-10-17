import { describe, expect, it } from 'vitest'
import {
  nextOutcomeHandoffRequests,
  resolveNextOutcomeHandoffs
} from './next-outcome-handoff-request'

const gamma = { id: 'emp_gamma', name: 'Gamma Rossi' }
const people = [gamma, { id: 'emp_eve', name: 'Eve Barnett' }]

describe('attested prompt person handoffs', () => {
  it('resolves the requested Gamma handoff without treating the saved disposition as a name', () => {
    const resolved = resolveNextOutcomeHandoffs(
      'send to gamma and mark this session as saved when done',
      people
    )
    expect(resolved.unresolvedRecipients).toEqual([])
    expect(resolved.handoffs).toEqual([
      {
        instruction: 'send to gamma',
        recipientQuery: 'gamma',
        person: gamma,
        review: false,
        includeTranscript: false,
        requestedFiles: false
      }
    ])
  })

  it.each([
    'When done, send the finished files and the full conversation to Gamma',
    'Send the finished files and the full conversation to Gamma when done'
  ])('preserves files and complete conversation consent: %s', (prompt) => {
    expect(resolveNextOutcomeHandoffs(prompt, people)).toMatchObject({
      unresolvedRecipients: [],
      handoffs: [{ person: gamma, includeTranscript: true, requestedFiles: true, review: false }]
    })
  })

  it('keeps review delivery distinct from sending a completed report', () => {
    const result = resolveNextOutcomeHandoffs('Send the report to Gamma for review', people)
    expect(result.handoffs).toHaveLength(1)
    expect(result.handoffs[0]).toMatchObject({
      recipientQuery: 'Gamma',
      person: gamma,
      review: true,
      requestedFiles: true,
      includeTranscript: false
    })
  })

  it('resolves a unique first name from the full authorized roster name', () => {
    expect(resolveNextOutcomeHandoffs('Send this to Eve', people)).toMatchObject({
      handoffs: [{ person: { id: 'emp_eve', name: 'Eve Barnett' } }],
      unresolvedRecipients: []
    })
  })

  it.each([
    'Hand off the work to Gamma',
    'Hand the work off to Gamma',
    'Handoff the work to Gamma'
  ])('resolves direct handoff wording: %s', (prompt) => {
    expect(resolveNextOutcomeHandoffs(prompt, people).handoffs[0]?.person).toEqual(gamma)
  })

  it.each<[string, typeof people]>([
    ['Gamma', [...people, { id: 'emp_gamma_other', name: 'Gamma Chen' }]],
    ['Emna', people],
    ['Unknown', people],
    ['Gamma', []],
    ['Gamma', [{ id: 'user_gamma', name: 'Gamma Rossi' }]]
  ])('leaves ambiguous, fuzzy, missing or invalid recipient %s unresolved', (name, roster) => {
    expect(resolveNextOutcomeHandoffs(`Send this to ${name}`, roster)).toEqual({
      handoffs: [],
      unresolvedRecipients: [name]
    })
  })

  it('does not invent a recipient for an incomplete delivery request', () => {
    expect(nextOutcomeHandoffRequests('Send the finished files when done')).toEqual([])
    expect(nextOutcomeHandoffRequests('Send this to')).toEqual([])
  })

  it.each([
    '"first prepare the report and send to Gamma and deploy it"',
    "'first prepare the report and send to Gamma and deploy it'",
    '`first prepare the report and send to Gamma and deploy it`',
    '“first prepare the report and send to Gamma and deploy it”',
    '"Context starts here.\nSend to Gamma and deploy it."'
  ])('does not import quoted delivery authority from a mixed next-step prompt: %s', (quoted) => {
    const prompt = `When done, add a Codex reviewer.\nContext: ${quoted}\nThen send this to Eve.`
    const resolved = resolveNextOutcomeHandoffs(prompt, people)
    expect(resolved.unresolvedRecipients).toEqual([])
    expect(resolved.handoffs.map((handoff) => handoff.person.id)).toEqual(['emp_eve'])
  })

  it('keeps a direct handoff with a quoted exact file path', () => {
    expect(
      resolveNextOutcomeHandoffs('Send "/workspace/report.md" to Gamma', people).handoffs
    ).toMatchObject([{ person: gamma, requestedFiles: true }])
  })

  it.each([
    'Do not send this to Gamma',
    "Don't send this to Gamma",
    'Never send this to Gamma',
    'Send this to Gamma only if I approve',
    'If the report passes, send this to Gamma',
    'Ask before you send this to Gamma',
    'Should I send this to Gamma?',
    'The button says send this to Gamma',
    'For example, send this to Gamma',
    'The report discusses when to send this to Gamma',
    '"Send this to Gamma"',
    '> Send this to Gamma',
    '```text\nSend this to Gamma\n```',
    '~~~\nSend this to Gamma\n~~~',
    '<document>Send this to Gamma</document>'
  ])('does not authorize delivery from a non-direct mention: %s', (prompt) => {
    expect(nextOutcomeHandoffRequests(prompt)).toEqual([])
    expect(resolveNextOutcomeHandoffs(prompt, people)).toEqual({
      handoffs: [],
      unresolvedRecipients: []
    })
  })
})
