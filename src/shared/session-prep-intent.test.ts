import { describe, expect, it } from 'vitest'
import { detectSessionPrepRequest, SESSION_PREP_TOKEN } from './session-prep-intent'

const positives: string[] = [
  'create sessions for the fair-use fix, the pricing badge and the invoice check',
  'spin up a new session to build the referral card',
  'Can you start 3 new sessions: A; B; C',
  'launch sessions for:\n- a\n- b',
  'please create a new session for fixing the archive shortcut',
  '(sessions) build X and Y',
  'Create a new agent to review PR #594',
  'could you create sessions for alpha and beta',
  'go ahead and start sessions to ship the badge',
  'kick off a new session for the invoice check',
  'fire up sessions for the archive shortcut',
  'set up a new session to review the pull request',
  'prep sessions for billing and refunds',
  'prepare a new session for the fair-use page',
  'make a new session for the pricing badge',
  'open a new conversation to handle billing and refunds',
  'create new agents for review and merge',
  'Create sessions that cover billing and refunds',
  'create sessions — fix the badge and the invoice',
  'create sessions - fix the badge and the invoice',
  'please can you launch sessions for one and two',
  'CREATE SESSIONS FOR ONE AND TWO',
  'Create a new conversation to review PR #594',
  'ok launch a session to draft all responses for customer service',
  'ok launch a sesssion to draft all responses for customer service',
  "ok let's try it, launch a session which builds a PR for the PDF on my desktop",
  'ok let\u2019s try it, launch a session which builds a PR for the PDF',
  'yeah create sessions for the badge and the invoice',
  'create a sesion to fix the login bug',
  'create a sessoin to fix the login bug',
  'start a session on the billing bug today',
  'launch a session with opus to fix the login bug',
  'launch 2 sessions, one for the badge and one for the invoice',
  'ok please create sessions for alpha and beta',
  '\u258e launch sessions to build a PR for each PDF on my Desktop',
  '- launch a session to fix the login bug',
  '\u2022 start sessions for alpha and beta'
]

const negatives: string[] = [
  'fix the fair-use page',
  'why did the pricing session fail?',
  'should we create a session for this?',
  'the new session is slow',
  'in this session, fix the archive shortcut',
  '/next create sessions for x',
  'start the dev server',
  'open the settings file',
  'create a PR for this',
  'launch the app',
  'do we need new sessions?',
  'what does start a session for X do?',
  'would you create a session for this work?',
  '',
  '   ',
  '/queue add create sessions for x',
  'How did the session fail?',
  'create a session for this',
  'create sessions for x',
  'start sessions',
  'Please fix this and create sessions for alpha and beta',
  'ok fix this, and create sessions for alpha and beta',
  'we can test with these launch sessions for these',
  'ok, why did the session fail?',
  'ok should we create a session for this?',
  'create a lesson to teach the new hires',
  'plan a season to launch the new line',
  '> create sessions for the badge and the invoice'
]

describe('detectSessionPrepRequest', () => {
  it('exports the explicit token', () => {
    expect(SESSION_PREP_TOKEN).toBe('(sessions)')
  })

  it.each(positives)('fires on: %s', (text) => {
    const detected = detectSessionPrepRequest(text)
    expect(detected).not.toBeNull()
    expect(detected?.request.length).toBeGreaterThan(0)
  })

  it.each(negatives)('does not fire on: %s', (text) => {
    expect(detectSessionPrepRequest(text)).toBeNull()
  })

  it('drops a copied quote bar or bullet from the returned request', () => {
    expect(detectSessionPrepRequest('\u258e launch sessions to build a PR for each PDF')).toEqual({
      request: 'launch sessions to build a PR for each PDF'
    })
  })

  it('returns the trimmed original request', () => {
    const text = '  create sessions for the fair-use fix and the badge  '
    expect(detectSessionPrepRequest(text)).toEqual({
      request: 'create sessions for the fair-use fix and the badge'
    })
  })

  it('strips (sessions) from the returned request', () => {
    expect(detectSessionPrepRequest('(sessions) build X and Y')).toEqual({
      request: 'build X and Y'
    })
    expect(detectSessionPrepRequest('build X and Y (sessions)')).toEqual({
      request: 'build X and Y'
    })
  })

  it('fires on (sessions) even when the text is a question', () => {
    expect(detectSessionPrepRequest('why did this fail (sessions)')).toEqual({
      request: 'why did this fail'
    })
  })

  it('does not treat a leading slash line as a request even with the token', () => {
    expect(detectSessionPrepRequest('/next (sessions) build X and Y')).toBeNull()
  })
})
