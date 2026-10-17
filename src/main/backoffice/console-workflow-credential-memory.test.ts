import { beforeEach, describe, expect, it, vi } from 'vitest'

const redactValue = vi.hoisted(() => vi.fn((value: unknown) => value))
vi.mock('../observability/redactor', () => ({ redactValue }))

import {
  _internals,
  redactConsoleWorkflowMemory,
  rememberConsoleWorkflowCredential
} from './console-workflow-credential-memory'

const OPAQUE = 'opaque/credential+with "quotes"'

beforeEach(() => {
  _internals.forgetConsoleWorkflowCredentials()
  redactValue.mockClear()
})

describe('redactConsoleWorkflowMemory', () => {
  it('redacts every spelling of a remembered credential', () => {
    rememberConsoleWorkflowCredential(OPAQUE)

    expect(
      redactConsoleWorkflowMemory({
        raw: `Bearer ${OPAQUE}`,
        url: `https://hub.invalid/?t=${encodeURIComponent(OPAQUE)}`,
        encoded: Buffer.from(OPAQUE).toString('base64'),
        kept: 'plain text'
      })
    ).toEqual({
      raw: 'Bearer [redacted]',
      url: 'https://hub.invalid/?t=[redacted]',
      encoded: '[redacted]',
      kept: 'plain text'
    })
  })

  it('redacts an earlier credential after later ones were remembered', () => {
    rememberConsoleWorkflowCredential('first-credential')
    rememberConsoleWorkflowCredential('second-credential')

    expect(redactConsoleWorkflowMemory(['first-credential', 'second-credential'])).toEqual([
      '[redacted]',
      '[redacted]'
    ])
  })

  it('costs one redaction pass for a clean value however many credentials are remembered', () => {
    for (let index = 0; index < 200; index += 1) {
      rememberConsoleWorkflowCredential(`credential-${index}`)
    }
    const value = { path: '/api/team/tasks', body: { note: 'Progress' } }

    expect(redactConsoleWorkflowMemory(value)).toEqual(value)
    expect(redactValue).toHaveBeenCalledTimes(1)
  })
})
