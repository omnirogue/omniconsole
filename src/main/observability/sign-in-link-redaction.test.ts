import { describe, expect, it } from 'vitest'
import { redactConsoleWorkflowMemory } from '../backoffice/console-workflow-credential-memory'
import { serializeConsoleWorkflowRequest } from '../backoffice/console-workflow-redaction'
import { redactString } from './redactor'
import {
  redactStringKeepingSignInLinks,
  redactValueKeepingSignInLinks
} from './sign-in-link-redaction'

const JWT = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`
const LIVE = `https://live.airtop.ai/d55ab91a-1066-4a53-acc9-ac908b5348f9?disableResize=false&token=${JWT}`

describe('an AirTop live view token', () => {
  it('stays redacted everywhere by default: telemetry, error tracking, other requests', () => {
    expect(redactString(`Sign in: ${LIVE}`)).not.toContain(JWT)
  })

  it('stays whole on the question-sync path', () => {
    expect(redactStringKeepingSignInLinks(`Sign in: ${LIVE}`)).toBe(`Sign in: ${LIVE}`)
    expect(redactValueKeepingSignInLinks({ items: [{ questions: [{ question: LIVE }] }] })).toEqual(
      {
        items: [{ questions: [{ question: LIVE }] }]
      }
    )
  })

  it('never shields text around the link (backticks, commas, other params)', () => {
    const out = redactStringKeepingSignInLinks(`\`${LIVE}\`,password=hunter2`)
    expect(out).toContain(LIVE)
    expect(out).not.toContain('hunter2')
    const extra = redactStringKeepingSignInLinks(`${LIVE}&secret=hunter3`)
    expect(extra).not.toContain('hunter3')
  })

  it('keeps an uppercase host, and input that already holds U+E000', () => {
    const upper = LIVE.replace('https://live.airtop.ai', 'https://LIVE.AIRTOP.AI')
    expect(redactStringKeepingSignInLinks(upper)).toBe(upper)
    expect(redactStringKeepingSignInLinks(` ${LIVE}`)).toBe(` ${LIVE}`)
  })

  it('redacts a token on any other host, and is idempotent', () => {
    expect(redactStringKeepingSignInLinks(`https://evil.example/x?token=${JWT}`)).not.toContain(JWT)
    const once = redactStringKeepingSignInLinks(`${LIVE} api_key=sk-zzz`)
    expect(redactStringKeepingSignInLinks(once)).toBe(once)
  })

  it('passes the transport check only where the sync route keeps sign-in links', () => {
    const body = { items: [{ questions: [{ question: `Sign in: ${LIVE}` }] }] }
    expect(() =>
      serializeConsoleWorkflowRequest(body, 'bearer-x', (value) =>
        redactConsoleWorkflowMemory(value, true)
      )
    ).not.toThrow()
    expect(() =>
      serializeConsoleWorkflowRequest(body, 'bearer-x', (value) =>
        redactConsoleWorkflowMemory(value)
      )
    ).toThrow()
  })
})
