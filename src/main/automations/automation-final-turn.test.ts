import { constants } from 'node:fs'
import type * as Fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseAutomationFinalTurn, readAutomationFinalTurn } from './automation-final-turn'

const filesystem = vi.hoisted(() => ({
  open: vi.fn(),
  stat: vi.fn(),
  read: vi.fn(),
  close: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof Fs>()),
  openSync: filesystem.open,
  fstatSync: filesystem.stat,
  readSync: filesystem.read,
  closeSync: filesystem.close
}))

const startedAt = Date.parse('2026-09-20T14:00:00.000Z')
const completedAt = startedAt + 10_000
const finalAt = startedAt + 4_000
const sessionId = 'routine-session'
const report = 'Verified report for the current automation run.'
const claudeInput = { agent: 'claude', sessionId, startedAt, completedAt } as const
const codexInput = { ...claudeInput, agent: 'codex' } as const
const maxTailBytes = 2 * 1024 * 1024

function transcript(...rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

function claudeUser(at = startedAt, content: unknown = 'Run the report') {
  return {
    type: 'user',
    sessionId,
    timestamp: new Date(at).toISOString(),
    message: { role: 'user', content }
  }
}

function claudeFinal(at = finalAt, content = report, stopReason: unknown = 'end_turn') {
  return {
    type: 'assistant',
    sessionId,
    timestamp: new Date(at).toISOString(),
    message: {
      role: 'assistant',
      stop_reason: stopReason,
      content: [{ type: 'text', text: content }] as Record<string, unknown>[]
    }
  }
}

function codexEvent(type: string, at: number, payload: Record<string, unknown> = {}) {
  return {
    type: 'event_msg',
    timestamp: new Date(at).toISOString(),
    payload: { type, ...payload }
  }
}

function codexStart(at = startedAt, turnId = 'turn-1') {
  return codexEvent('task_started', at, { turn_id: turnId })
}

function codexUser(at = startedAt, content = 'Run the report') {
  return {
    type: 'response_item',
    timestamp: new Date(at).toISOString(),
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: content }]
    }
  }
}

function codexFinal(at = finalAt, content = report, turnId = 'turn-1') {
  return codexEvent('task_complete', at, {
    turn_id: turnId,
    last_agent_message: content
  })
}

describe('parseAutomationFinalTurn Claude provenance', () => {
  it.each(['end_turn', 'stop_sequence'])('accepts an explicit %s current-turn final', (reason) => {
    expect(
      parseAutomationFinalTurn(
        transcript(claudeUser(), claudeFinal(finalAt, report, reason)),
        claudeInput
      )
    ).toEqual({ content: report, completedAt: finalAt })
  })

  it.each([undefined, null, 'tool_use', 'max_tokens', 'refusal'])(
    'rejects an unproven stop reason: %s',
    (reason) => {
      const final = claudeFinal()
      final.message.stop_reason = reason
      expect(parseAutomationFinalTurn(transcript(claudeUser(), final), claudeInput)).toBeNull()
    }
  )

  it.each(['', ' \n\t '])('rejects an empty final report: %j', (content) => {
    expect(
      parseAutomationFinalTurn(transcript(claudeUser(), claudeFinal(finalAt, content)), claudeInput)
    ).toBeNull()
  })

  it('does not mistake tool-use text or tool output for a final report', () => {
    const toolUse = claudeFinal()
    toolUse.message.content = [
      { type: 'text', text: 'About to inspect the account.' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }
    ]

    expect(parseAutomationFinalTurn(transcript(claudeUser(), toolUse), claudeInput)).toBeNull()
    expect(
      parseAutomationFinalTurn(
        transcript(
          claudeUser(),
          claudeUser(finalAt, [{ type: 'tool_result', tool_use_id: 'tool-1', content: report }])
        ),
        claudeInput
      )
    ).toBeNull()
  })

  it('keeps a pure tool-result user row within the selected turn', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(
          claudeUser(),
          claudeFinal(startedAt + 1_000, 'Checking data.', 'tool_use'),
          claudeUser(startedAt + 2_000, [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'Private raw tool output' }
          ]),
          claudeFinal()
        ),
        claudeInput
      )
    ).toEqual({ content: report, completedAt: finalAt })
  })

  it.each([{ error: 'rate_limit_error' }, { isApiErrorMessage: true }, { apiErrorStatus: 429 }])(
    'rejects a provider-error assistant record: %j',
    (errorFields) => {
      expect(
        parseAutomationFinalTurn(
          transcript(claudeUser(), { ...claudeFinal(), ...errorFields }),
          claudeInput
        )
      ).toBeNull()
    }
  )

  it('rejects the actual API-error shape followed by a turn-duration marker', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(
          claudeUser(),
          {
            ...claudeFinal(finalAt, 'API Error: 429 Too many requests', null),
            error: 'rate_limit',
            isApiErrorMessage: true,
            apiErrorStatus: 429
          },
          {
            type: 'system',
            subtype: 'turn_duration',
            sessionId,
            timestamp: new Date(finalAt + 1).toISOString(),
            durationMs: 4_501
          }
        ),
        claudeInput
      )
    ).toBeNull()
  })

  it('never falls back to a prior successful turn when this turn errors', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(
          claudeUser(startedAt - 8_000),
          claudeFinal(startedAt - 4_000, 'Previous successful report'),
          claudeUser(),
          { ...claudeFinal(), isApiErrorMessage: true }
        ),
        claudeInput
      )
    ).toBeNull()
  })

  it('does not recover a failed selected turn with later final-looking text', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(
          claudeUser(),
          { ...claudeFinal(startedAt + 1_000), error: 'overloaded_error' },
          claudeFinal()
        ),
        claudeInput
      )
    ).toBeNull()
  })

  it('requires a current user prompt, with no five-second early allowance', () => {
    for (const rows of [[claudeFinal()], [claudeUser(startedAt - 1), claudeFinal()]]) {
      expect(parseAutomationFinalTurn(transcript(...rows), claudeInput)).toBeNull()
    }
  })

  it.each([{ isMeta: true }, { isCompactSummary: true }])(
    'does not treat synthetic user metadata as the run prompt: %j',
    (metadata) => {
      expect(
        parseAutomationFinalTurn(
          transcript({ ...claudeUser(), ...metadata }, claudeFinal()),
          claudeInput
        )
      ).toBeNull()
    }
  )

  it.each([
    { content: undefined },
    { content: '' },
    { content: ' \n ' },
    { content: [] },
    { content: [{ type: 'text', text: '' }] }
  ])('requires a nonempty user prompt: %j', ({ content }) => {
    const user = claudeUser()
    user.message.content = content
    expect(parseAutomationFinalTurn(transcript(user, claudeFinal()), claudeInput)).toBeNull()
  })

  it('accepts exact run boundaries but rejects a final one millisecond beyond completion', () => {
    expect(
      parseAutomationFinalTurn(transcript(claudeUser(), claudeFinal(completedAt)), claudeInput)
    ).toEqual({ content: report, completedAt })
    expect(
      parseAutomationFinalTurn(transcript(claudeUser(), claudeFinal(completedAt + 1)), claudeInput)
    ).toBeNull()
  })

  it('does not substitute a later user turn for the unfinished automation turn', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(claudeUser(), claudeUser(startedAt + 2_000), claudeFinal()),
        claudeInput
      )
    ).toBeNull()
  })

  it('keeps the selected final when subsequent user activity has a different report', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(
          claudeUser(),
          claudeFinal(),
          claudeUser(startedAt + 6_000),
          claudeFinal(startedAt + 8_000, 'Not the automation result')
        ),
        claudeInput
      )
    ).toEqual({ content: report, completedAt: finalAt })
  })

  it('rejects an explicit transcript session mismatch', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(claudeUser(), { ...claudeFinal(), sessionId: 'other-session' }),
        claudeInput
      )
    ).toBeNull()
  })
})

describe('parseAutomationFinalTurn Codex provenance', () => {
  it('uses the exact matching task-complete last_agent_message', () => {
    const exactReport = ` \n${report}\n `
    expect(
      parseAutomationFinalTurn(
        transcript(
          codexStart(),
          codexUser(),
          codexEvent('agent_message', startedAt + 1_000, { message: 'Preliminary text' }),
          codexFinal(finalAt, exactReport)
        ),
        codexInput
      )
    ).toEqual({ content: exactReport, completedAt: finalAt })
  })

  it('accepts an event user_message as the current user boundary', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(
          codexStart(),
          codexEvent('user_message', startedAt, { message: 'Run the report' }),
          codexFinal()
        ),
        codexInput
      )
    ).toEqual({ content: report, completedAt: finalAt })
  })

  it('accepts matching event and response representations of the same prompt', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(
          codexStart(),
          codexEvent('user_message', startedAt, { message: 'Run the report' }),
          codexUser(),
          codexFinal()
        ),
        codexInput
      )
    ).toEqual({ content: report, completedAt: finalAt })
  })

  it.each<[string, unknown[]]>([
    ['task-start boundary', [codexUser(), codexFinal()]],
    ['current user prompt', [codexStart(), codexFinal()]],
    ['matching turn id', [codexStart(), codexUser(), codexFinal(finalAt, report, 'other-turn')]],
    ['task-start turn id', [codexEvent('task_started', startedAt), codexUser(), codexFinal()]],
    [
      'task-complete turn id',
      [
        codexStart(),
        codexUser(),
        codexEvent('task_complete', finalAt, { last_agent_message: report })
      ]
    ]
  ])('requires the %s', (_label, rows) => {
    expect(parseAutomationFinalTurn(transcript(...rows), codexInput)).toBeNull()
  })

  it.each([undefined, null, '', ' \n\t '])(
    'rejects absent or empty last_agent_message: %j',
    (text) => {
      expect(
        parseAutomationFinalTurn(
          transcript(
            codexStart(),
            codexUser(),
            codexEvent('task_complete', finalAt, { turn_id: 'turn-1', last_agent_message: text })
          ),
          codexInput
        )
      ).toBeNull()
    }
  )

  it('never falls back to an assistant final response without a task-complete payload', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(codexStart(), codexUser(), {
          type: 'response_item',
          timestamp: new Date(finalAt).toISOString(),
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: report }]
          }
        }),
        codexInput
      )
    ).toBeNull()
  })

  it.each(['turn_aborted', 'error'])('rejects a selected turn with %s', (type) => {
    expect(
      parseAutomationFinalTurn(
        transcript(
          codexStart(),
          codexUser(),
          codexEvent(type, startedAt + 1_000, { turn_id: 'turn-1', message: 'Request failed' }),
          codexFinal()
        ),
        codexInput
      )
    ).toBeNull()
  })

  it('does not use a previous final or a later completed turn when this turn is unfinished', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(
          codexStart(startedAt - 8_000, 'old-turn'),
          codexUser(startedAt - 8_000),
          codexFinal(startedAt - 4_000, 'Previous report', 'old-turn'),
          codexStart(),
          codexUser(),
          codexStart(startedAt + 2_000, 'later-turn'),
          codexUser(startedAt + 2_000),
          codexFinal(finalAt, 'Later report', 'later-turn')
        ),
        codexInput
      )
    ).toBeNull()
  })

  it('accepts the native context and actual prompt user rows within one task', () => {
    const context = '# AGENTS.md context\n'.padEnd(25_487, '.')
    const prompt = 'Produce the automation report.'.padEnd(290, '.')
    expect(
      parseAutomationFinalTurn(
        transcript(
          codexStart(),
          codexUser(startedAt, context),
          codexUser(startedAt + 1, prompt),
          codexFinal()
        ),
        codexInput
      )
    ).toEqual({ content: report, completedAt: finalAt })
  })

  it('keeps the first result when another user prompt follows completion', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(
          codexStart(),
          codexUser(),
          codexFinal(),
          codexUser(startedAt + 6_000, 'Not the automation prompt'),
          codexFinal(startedAt + 8_000, 'Not the automation result')
        ),
        codexInput
      )
    ).toEqual({ content: report, completedAt: finalAt })
  })

  it('requires a current task and user timestamp, with no five-second early allowance', () => {
    for (const rows of [
      [codexStart(startedAt - 1), codexUser(), codexFinal()],
      [codexStart(), codexUser(startedAt - 1), codexFinal()]
    ]) {
      expect(parseAutomationFinalTurn(transcript(...rows), codexInput)).toBeNull()
    }
  })

  it('rejects a task-complete timestamp beyond the run completion bound', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(codexStart(), codexUser(), codexFinal(completedAt + 1)),
        codexInput
      )
    ).toBeNull()
  })

  it('rejects an explicit session_meta id mismatch', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(
          { type: 'session_meta', payload: { id: 'other-session' } },
          codexStart(),
          codexUser(),
          codexFinal()
        ),
        codexInput
      )
    ).toBeNull()
  })

  it.each([undefined, null, ''])('rejects malformed session_meta id: %j', (id) => {
    expect(
      parseAutomationFinalTurn(
        transcript(
          { type: 'session_meta', payload: { id } },
          codexStart(),
          codexUser(),
          codexFinal()
        ),
        codexInput
      )
    ).toBeNull()
  })
})

describe('parseAutomationFinalTurn record integrity', () => {
  it.each(['{broken', 'null', '[]', 'true', '42'])(
    'rejects a malformed or non-object transcript record: %s',
    (line) => {
      expect(
        parseAutomationFinalTurn(`${line}\n${transcript(claudeUser(), claudeFinal())}`, claudeInput)
      ).toBeNull()
    }
  )

  it.each([
    { startedAt: Number.NaN },
    { completedAt: Number.POSITIVE_INFINITY },
    { completedAt: startedAt - 1 },
    { sessionId: '' }
  ])('rejects invalid run scope: %j', (scope) => {
    expect(
      parseAutomationFinalTurn(transcript(claudeUser(), claudeFinal()), {
        ...claudeInput,
        ...scope
      })
    ).toBeNull()
  })

  it('rejects an untimestamped selected final rather than borrowing the run completion time', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(claudeUser(), { ...claudeFinal(), timestamp: undefined }),
        claudeInput
      )
    ).toBeNull()
  })

  it('rejects untimestamped nested errors instead of ignoring them as metadata', () => {
    expect(
      parseAutomationFinalTurn(
        transcript(claudeUser(), { type: 'system', message: { is_error: true } }, claudeFinal()),
        claudeInput
      )
    ).toBeNull()
    expect(
      parseAutomationFinalTurn(
        transcript(
          codexStart(),
          codexUser(),
          { type: 'system', payload: { is_error: true } },
          codexFinal()
        ),
        codexInput
      )
    ).toBeNull()
  })
})

describe('readAutomationFinalTurn bounded filesystem evidence', () => {
  const input = { ...claudeInput, transcriptPath: 'current-session.jsonl' }
  let fileBytes: Buffer

  beforeEach(() => {
    vi.resetAllMocks()
    fileBytes = Buffer.from(transcript(claudeUser(), claudeFinal()))
    filesystem.open.mockReturnValue(23)
    filesystem.stat.mockImplementation(() => ({
      size: fileBytes.length,
      mtimeMs: 123,
      isFile: () => true
    }))
    filesystem.read.mockImplementation(
      (_fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
        fileBytes.copy(buffer, offset, position, position + length)
    )
  })

  it('opens nonblocking, checks the same file descriptor, and closes a successful read', () => {
    expect(readAutomationFinalTurn(input)).toEqual({ content: report, completedAt: finalAt })
    expect(filesystem.open).toHaveBeenCalledWith(
      input.transcriptPath,
      constants.O_RDONLY | constants.O_NONBLOCK
    )
    expect(filesystem.stat).toHaveBeenCalledWith(23)
    expect(filesystem.stat).toHaveBeenCalledTimes(2)
    expect(filesystem.read).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Buffer),
      0,
      fileBytes.length,
      0
    )
    expect(filesystem.close).toHaveBeenCalledOnce()
    expect(filesystem.close).toHaveBeenCalledWith(23)
  })

  it.each(['claude', 'codex'] as const)(
    'reads at most 2 MiB with a retained pre-start %s boundary',
    (agent) => {
      const rows =
        agent === 'claude'
          ? [claudeUser(startedAt - 1), claudeUser(), claudeFinal()]
          : [
              codexStart(startedAt - 1, 'prior-turn'),
              codexStart(),
              codexUser(startedAt, '# AGENTS.md context'.padEnd(25_487, '.')),
              codexUser(startedAt + 1, 'Run the report'.padEnd(290, '.')),
              codexFinal()
            ]
      fileBytes = Buffer.from(`${'x'.repeat(maxTailBytes + 100)}\n${transcript(...rows)}`)

      expect(readAutomationFinalTurn({ ...input, agent })).toEqual({
        content: report,
        completedAt: finalAt
      })
      expect(filesystem.read).toHaveBeenCalledWith(
        23,
        expect.any(Buffer),
        0,
        maxTailBytes,
        fileBytes.length - maxTailBytes
      )
      expect(filesystem.read.mock.calls[0][1].byteLength).toBeLessThanOrEqual(maxTailBytes)
    }
  )

  it.each(['claude', 'codex'] as const)(
    'does not replace a dropped original %s turn or error with a later successful turn',
    (agent) => {
      const original = agent === 'claude' ? [claudeUser()] : [codexStart(), codexUser()]
      const error =
        agent === 'claude'
          ? { ...claudeFinal(startedAt + 1_000), isApiErrorMessage: true }
          : codexEvent('error', startedAt + 1_000, { turn_id: 'turn-1' })
      const later =
        agent === 'claude'
          ? [claudeUser(startedAt + 2_000), claudeFinal()]
          : [
              codexStart(startedAt + 2_000, 'later-turn'),
              codexUser(startedAt + 2_000),
              codexFinal(finalAt, report, 'later-turn')
            ]
      for (const prefix of [original, [...original, error]]) {
        fileBytes = Buffer.from(
          `${transcript(...prefix)}${'x'.repeat(maxTailBytes + 100)}\n${transcript(...later)}`
        )
        expect(readAutomationFinalTurn({ ...input, agent })).toBeNull()
      }
    }
  )

  it.each([{ isMeta: true }, { isCompactSummary: true }, { isSidechain: true }])(
    'does not use synthetic or sidechain Claude user metadata as a retained anchor: %j',
    (metadata) => {
      const rows = [{ ...claudeUser(startedAt - 1), ...metadata }, claudeUser(), claudeFinal()]
      fileBytes = Buffer.from(`${'x'.repeat(maxTailBytes + 100)}\n${transcript(...rows)}`)
      expect(readAutomationFinalTurn(input)).toBeNull()
    }
  )

  it.each(['claude', 'codex'] as const)(
    'does not allow a pre-start %s anchor retained after the first current record to rescue the tail',
    (agent) => {
      const rows =
        agent === 'claude'
          ? [claudeUser(), claudeUser(startedAt - 1), claudeFinal()]
          : [codexStart(), codexStart(startedAt - 1, 'prior-turn'), codexUser(), codexFinal()]
      fileBytes = Buffer.from(`${'x'.repeat(maxTailBytes + 100)}\n${transcript(...rows)}`)
      expect(readAutomationFinalTurn({ ...input, agent })).toBeNull()
    }
  )

  it('does not use Codex session metadata instead of a retained pre-start task boundary', () => {
    const metadata = {
      type: 'session_meta',
      timestamp: new Date(startedAt - 1).toISOString(),
      payload: { id: sessionId }
    }
    fileBytes = Buffer.from(
      `${'x'.repeat(maxTailBytes + 100)}\n${transcript(metadata, codexStart(), codexUser(), codexFinal())}`
    )
    expect(readAutomationFinalTurn({ ...input, agent: 'codex' })).toBeNull()
  })

  it('cannot prove a turn when its user boundary falls outside the bounded tail', () => {
    fileBytes = Buffer.from(
      `${transcript(claudeUser())}${'x'.repeat(maxTailBytes)}\n${transcript(claudeFinal())}`
    )

    expect(readAutomationFinalTurn(input)).toBeNull()
  })

  it.each(['unterminated complete JSON', 'truncated JSON'])('rejects an %s final line', (kind) => {
    const text = transcript(claudeUser(), claudeFinal())
    fileBytes = Buffer.from(text.slice(0, kind === 'truncated JSON' ? -3 : -1))

    expect(readAutomationFinalTurn(input)).toBeNull()
    expect(parseAutomationFinalTurn(fileBytes.toString('utf8'), claudeInput)).toBeNull()
    expect(filesystem.close).toHaveBeenCalledWith(23)
  })

  it('rejects a short read even when the bytes read contain a complete valid final', () => {
    const prefixLength = fileBytes.length
    fileBytes = Buffer.concat([fileBytes, Buffer.from('unread trailing record\n')])
    filesystem.read.mockImplementationOnce((_fd: number, buffer: Buffer) =>
      fileBytes.copy(buffer, 0, 0, prefixLength)
    )

    expect(readAutomationFinalTurn(input)).toBeNull()
    expect(filesystem.close).toHaveBeenCalledWith(23)
  })

  it.each(['size', 'mtimeMs'])('rejects a file whose %s changes during the read', (field) => {
    filesystem.stat
      .mockReturnValueOnce({
        size: fileBytes.length,
        mtimeMs: 123,
        isFile: () => true
      })
      .mockReturnValueOnce({
        size: fileBytes.length,
        mtimeMs: 123,
        [field]: field === 'size' ? fileBytes.length + 1 : 124,
        isFile: () => true
      })

    expect(readAutomationFinalTurn(input)).toBeNull()
    expect(filesystem.close).toHaveBeenCalledWith(23)
  })

  it('rejects a non-file without attempting to read it', () => {
    filesystem.stat.mockReturnValue({ size: 100, mtimeMs: 123, isFile: () => false })

    expect(readAutomationFinalTurn(input)).toBeNull()
    expect(filesystem.read).not.toHaveBeenCalled()
    expect(filesystem.close).toHaveBeenCalledWith(23)
  })

  it.each([0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an empty or invalid observed file size: %s',
    (size) => {
      filesystem.stat.mockReturnValue({ size, mtimeMs: 123, isFile: () => true })

      expect(readAutomationFinalTurn(input)).toBeNull()
      expect(filesystem.read).not.toHaveBeenCalled()
      expect(filesystem.close).toHaveBeenCalledWith(23)
    }
  )

  it('rejects invalid UTF-8 instead of accepting replacement text as a report', () => {
    const encoded = Buffer.from(transcript(claudeUser(), claudeFinal()))
    const reportOffset = encoded.indexOf(report)
    encoded[reportOffset] = 0xff
    fileBytes = encoded

    expect(readAutomationFinalTurn(input)).toBeNull()
    expect(filesystem.close).toHaveBeenCalledWith(23)
  })

  it('returns null if opening the source fails', () => {
    filesystem.open.mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })

    expect(readAutomationFinalTurn(input)).toBeNull()
    expect(filesystem.close).not.toHaveBeenCalled()
  })

  it.each(['stat', 'read'] as const)('closes the descriptor after a %s failure', (operation) => {
    filesystem[operation].mockImplementationOnce(() => {
      throw new Error('EIO')
    })

    expect(readAutomationFinalTurn(input)).toBeNull()
    expect(filesystem.close).toHaveBeenCalledWith(23)
  })
})
