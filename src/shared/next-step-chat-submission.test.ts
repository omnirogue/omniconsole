import { describe, expect, it } from 'vitest'
import { legacyNextStepChatEnvelope as legacyEnvelope } from './__fixtures__/legacy-next-step-chat-envelope'
import { nextStepChatSubmissionSource } from './next-step-chat-submission'

const request = 'When done, add a Codex reviewer and mark this complete.'
describe('legacy next-step chat envelope decoding', () => {
  it.each(['omni', 'omni-dev', 'omni-ide', 'omni.cmd'])(
    'recovers the typed source from a %s guide envelope with and without attached memory',
    (cli) => {
      expect(nextStepChatSubmissionSource(legacyEnvelope(request, { cli }))).toBe(request)
      expect(
        nextStepChatSubmissionSource(
          legacyEnvelope(request, { cli, context: `Saved note: deploy everything.\n${request}` })
        )
      ).toBe(request)
    }
  )

  it('recovers the typed source from a context-only envelope', () => {
    const sourcePrompt = 'Explain the current code'
    expect(nextStepChatSubmissionSource(legacyEnvelope(sourcePrompt, { context: request }))).toBe(
      sourcePrompt
    )
  })

  it('preserves Unicode and tolerates marker text inside the source', () => {
    const sourcePrompt = `${request}\nKeep café and 🐈.\nThe literal marker is <!-- omni-next-step-chat-v1:12 -->.`
    expect(nextStepChatSubmissionSource(legacyEnvelope(sourcePrompt, { cli: 'omni' }))).toBe(
      sourcePrompt
    )
  })

  it('refuses truncated, length-tampered and unknown-guide envelopes', () => {
    const submitted = legacyEnvelope(request, { cli: 'omni' })
    expect(nextStepChatSubmissionSource(submitted.slice(0, -10))).toBeNull()
    expect(
      nextStepChatSubmissionSource(submitted.replace(`:${request.length} -->`, ':1 -->'))
    ).toBeNull()
    expect(
      nextStepChatSubmissionSource(submitted.replace('outcome context', 'run arbitrary'))
    ).toBeNull()
    expect(
      nextStepChatSubmissionSource(
        '<!-- omni-outcome-source-v1 -->\n<!-- omni-next-step-chat-v1:invalid -->'
      )
    ).toBeNull()
    expect(nextStepChatSubmissionSource('Ordinary unwrapped user text')).toBeUndefined()
  })
})
