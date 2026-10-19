import { afterEach, describe, expect, it } from 'vitest'
import {
  TERMINAL_PARKED_PREVIEW_TAIL_AGGREGATE_MAX_BYTES,
  TERMINAL_PARKED_PREVIEW_TAIL_MAX_BYTES,
  TERMINAL_PARKED_PREVIEW_TAIL_MAX_LINES
} from './terminal-hidden-view-parking'
import {
  appendParkedTerminalPreviewOutput,
  clearParkedTerminalPreviewTail,
  createTerminalPreviewTailRing,
  getParkedTerminalPreviewTail,
  getParkedTerminalPreviewTailCensus,
  resetParkedTerminalPreviewTailsForTests,
  takeUtf8Tail,
  utf8ByteLength
} from './terminal-parked-preview-tail'

const ESC = '\x1b'
const BEL = '\x07'

function ring(maxLines = 4, maxBytes = 1024): ReturnType<typeof createTerminalPreviewTailRing> {
  return createTerminalPreviewTailRing({ maxLines, maxBytes })
}

describe('parked preview tail budget', () => {
  it('is bounded to 64 lines and 8 KB per parked PTY', () => {
    expect(TERMINAL_PARKED_PREVIEW_TAIL_MAX_LINES).toBe(64)
    expect(TERMINAL_PARKED_PREVIEW_TAIL_MAX_BYTES).toBe(8 * 1024)
  })

  it('caps the aggregate well below the per-PTY budget times a 50-session fleet', () => {
    expect(TERMINAL_PARKED_PREVIEW_TAIL_AGGREGATE_MAX_BYTES).toBeGreaterThanOrEqual(
      TERMINAL_PARKED_PREVIEW_TAIL_MAX_BYTES
    )
    expect(TERMINAL_PARKED_PREVIEW_TAIL_AGGREGATE_MAX_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024)
  })
})

describe('utf8ByteLength', () => {
  it('counts ASCII, 2-byte, 3-byte and surrogate-pair code points', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('€')).toBe(3)
    expect(utf8ByteLength('😀')).toBe(4)
    expect(utf8ByteLength('a€😀')).toBe(8)
  })

  it('counts a lone high surrogate at the end as 3 bytes', () => {
    expect(utf8ByteLength('\ud83d')).toBe(3)
  })
})

describe('takeUtf8Tail', () => {
  it('returns the text unchanged when it fits', () => {
    expect(takeUtf8Tail('hello', 5)).toBe('hello')
  })

  it('keeps the newest suffix that fits', () => {
    expect(takeUtf8Tail('abcdef', 3)).toBe('def')
  })

  it('never splits a surrogate pair', () => {
    expect(takeUtf8Tail('x😀', 3)).toBe('')
    expect(takeUtf8Tail('x😀', 4)).toBe('😀')
    expect(takeUtf8Tail('x😀', 5)).toBe('x😀')
  })

  it('drops a multi-byte character that would exceed the budget', () => {
    expect(takeUtf8Tail('€€', 4)).toBe('€')
  })
})

describe('createTerminalPreviewTailRing', () => {
  it('commits complete lines and exposes the open line as the last entry', () => {
    const tail = ring()
    tail.append('one\ntwo\nthr')

    expect(tail.getLines()).toEqual(['one', 'two', 'thr'])
    tail.append('ee\n')
    expect(tail.getLines()).toEqual(['one', 'two', 'three'])
  })

  it('keeps blank lines that are part of the output', () => {
    const tail = ring()
    tail.append('a\n\nb\n')

    expect(tail.getLines()).toEqual(['a', '', 'b'])
  })

  it('treats CRLF as one line break', () => {
    const tail = ring()
    tail.append('a\r\nb\r\n')

    expect(tail.getLines()).toEqual(['a', 'b'])
  })

  it('keeps a line whose CRLF is split across chunks', () => {
    const tail = ring()
    tail.append('hello\r')
    expect(tail.getLines()).toEqual(['hello'])
    tail.append('\nworld')

    expect(tail.getLines()).toEqual(['hello', 'world'])
  })

  it('does not spend a line slot on a lone pending CR', () => {
    const tail = ring(2)
    tail.append('a\nb\n\r')

    expect(tail.getLines()).toEqual(['a', 'b'])
    expect(tail.isTruncated()).toBe(false)
  })

  it('lets a bare CR overwrite the open line like a progress bar', () => {
    const tail = ring()
    tail.append('progress 10%')
    tail.append('\rprogress 50%')
    tail.append('\rprogress 100%\n')

    expect(tail.getLines()).toEqual(['progress 100%'])
  })

  it('evicts the oldest lines once the line budget is reached', () => {
    const tail = ring(3)
    tail.append('1\n2\n3\n4\n5\n')

    expect(tail.getLines()).toEqual(['3', '4', '5'])
    expect(tail.isTruncated()).toBe(true)
  })

  it('counts the open line against the line budget', () => {
    const tail = ring(3)
    tail.append('1\n2\n3\nopen')

    expect(tail.getLines()).toEqual(['2', '3', 'open'])
  })

  it('wraps the ring repeatedly without losing order', () => {
    const tail = ring(4)
    for (let index = 0; index < 50; index += 1) {
      tail.append(`line-${index}\n`)
    }

    expect(tail.getLines()).toEqual(['line-46', 'line-47', 'line-48', 'line-49'])
  })

  it('evicts by bytes before the line cap when lines are wide', () => {
    const tail = ring(10, 10)
    tail.append('aaaa\nbbbb\ncccc\n')

    expect(tail.getLines()).toEqual(['bbbb', 'cccc'])
    expect(tail.getBytes()).toBe(8)
    expect(tail.isTruncated()).toBe(true)
  })

  it('keeps only the newest bytes of a single oversized line', () => {
    const tail = ring(4, 8)
    tail.append(`${'x'.repeat(20)}tail1234\n`)

    expect(tail.getLines()).toEqual(['tail1234'])
    expect(tail.getBytes()).toBe(8)
    expect(tail.isTruncated()).toBe(true)
  })

  it('bounds an open line that never receives a newline', () => {
    const tail = ring(4, 16)
    for (let index = 0; index < 100; index += 1) {
      tail.append('0123456789')
    }

    expect(tail.getBytes()).toBeLessThanOrEqual(16)
    expect(tail.getLines()).toHaveLength(1)
    expect(tail.getLines()[0]).toMatch(/^[0-9]+$/)
  })

  it('reports not truncated while everything fits', () => {
    const tail = ring()
    tail.append('fits\n')

    expect(tail.isTruncated()).toBe(false)
    expect(tail.getBytes()).toBe(4)
  })

  it('accounts UTF-8 bytes, not UTF-16 code units', () => {
    const tail = ring(4, 1024)
    tail.append('€😀\n')

    expect(tail.getBytes()).toBe(7)
  })

  it('clamps nonsensical limits to at least one line and one byte', () => {
    const tail = createTerminalPreviewTailRing({ maxLines: 0, maxBytes: 0 })
    tail.append('ab\ncd\n')

    expect(tail.getLines()).toEqual(['d'])
    expect(tail.getBytes()).toBe(1)
  })

  it('strips SGR colour and cursor sequences', () => {
    const tail = ring()
    tail.append(`${ESC}[31mred${ESC}[0m ${ESC}[2Kplain\n`)

    expect(tail.getLines()).toEqual(['red plain'])
  })

  it('strips OSC title and hyperlink sequences so preview text stays inert', () => {
    const tail = ring()
    tail.append(
      `${ESC}]0;window title${BEL}${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\\n`
    )

    expect(tail.getLines()).toEqual(['link'])
  })

  it('holds an escape sequence split across chunks instead of leaking it as text', () => {
    const tail = ring()
    tail.append(`before${ESC}[3`)
    expect(tail.getLines()).toEqual(['before'])
    tail.append('1mafter\n')

    expect(tail.getLines()).toEqual(['beforeafter'])
  })

  it('holds a split OSC until its terminator arrives', () => {
    const tail = ring()
    tail.append(`a${ESC}]0;ti`)
    tail.append(`tle${BEL}b\n`)

    expect(tail.getLines()).toEqual(['ab'])
  })

  it('does not hold an unterminated OSC forever', () => {
    const tail = ring(4, 4096)
    tail.append(`${ESC}]0;${'x'.repeat(300)}`)
    tail.append('visible\n')

    expect(tail.getLines()).toEqual(['visible'])
  })

  it('ignores chunks that sanitize to nothing', () => {
    const tail = ring()
    tail.append('kept\n')
    tail.append(`${ESC}[?25l${ESC}[H`)

    expect(tail.getLines()).toEqual(['kept'])
  })

  it('drops other C0 controls such as BEL and backspace', () => {
    const tail = ring()
    tail.append(`ding${BEL}\n`)

    expect(tail.getLines()).toEqual(['ding'])
  })

  it('returns a fresh lines array each read', () => {
    const tail = ring()
    tail.append('a\n')
    const first = tail.getLines()
    first.push('mutated')

    expect(tail.getLines()).toEqual(['a'])
  })
})

describe('parked preview tail registry', () => {
  afterEach(() => {
    resetParkedTerminalPreviewTailsForTests()
  })

  it('returns null for a PTY that never produced parked output', () => {
    expect(getParkedTerminalPreviewTail('pty-none')).toBeNull()
  })

  it('exposes lastPreviewLines labelled as recent output', () => {
    appendParkedTerminalPreviewOutput('pty-1', 'build ok\n$ ', 1_000)

    expect(getParkedTerminalPreviewTail('pty-1')).toEqual({
      ptyId: 'pty-1',
      sourceKind: 'recent-output',
      epoch: expect.any(Number),
      lastPreviewLines: ['build ok', '$ '],
      bytes: 10,
      truncated: false,
      lastUpdatedAt: 1_000
    })
  })

  it('keeps PTYs isolated from each other', () => {
    appendParkedTerminalPreviewOutput('pty-a', 'alpha\n')
    appendParkedTerminalPreviewOutput('pty-b', 'beta\n')

    expect(getParkedTerminalPreviewTail('pty-a')?.lastPreviewLines).toEqual(['alpha'])
    expect(getParkedTerminalPreviewTail('pty-b')?.lastPreviewLines).toEqual(['beta'])
  })

  it('updates lastUpdatedAt on every write', () => {
    appendParkedTerminalPreviewOutput('pty-1', 'a', 10)
    appendParkedTerminalPreviewOutput('pty-1', 'b', 20)

    expect(getParkedTerminalPreviewTail('pty-1')?.lastUpdatedAt).toBe(20)
  })

  it('enforces the 64-line per-PTY budget', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `l${index}`)
    appendParkedTerminalPreviewOutput('pty-1', `${lines.join('\n')}\n`)
    const snapshot = getParkedTerminalPreviewTail('pty-1')

    expect(snapshot?.lastPreviewLines).toHaveLength(TERMINAL_PARKED_PREVIEW_TAIL_MAX_LINES)
    expect(snapshot?.lastPreviewLines[0]).toBe('l36')
    expect(snapshot?.lastPreviewLines.at(-1)).toBe('l99')
    expect(snapshot?.truncated).toBe(true)
  })

  it('enforces the 8 KB per-PTY budget', () => {
    const wide = 'w'.repeat(1000)
    for (let index = 0; index < 20; index += 1) {
      appendParkedTerminalPreviewOutput('pty-1', `${wide}\n`)
    }
    const snapshot = getParkedTerminalPreviewTail('pty-1')

    expect(snapshot?.bytes).toBeLessThanOrEqual(TERMINAL_PARKED_PREVIEW_TAIL_MAX_BYTES)
    expect(snapshot?.lastPreviewLines).toHaveLength(8)
  })

  it('clears a tail on reveal and gives a recreated tail a new epoch', () => {
    appendParkedTerminalPreviewOutput('pty-1', 'old\n')
    const firstEpoch = getParkedTerminalPreviewTail('pty-1')?.epoch
    clearParkedTerminalPreviewTail('pty-1')

    expect(getParkedTerminalPreviewTail('pty-1')).toBeNull()
    expect(getParkedTerminalPreviewTailCensus()).toEqual({ tails: 0, bytes: 0 })

    appendParkedTerminalPreviewOutput('pty-1', 'new\n')
    const second = getParkedTerminalPreviewTail('pty-1')
    expect(second?.lastPreviewLines).toEqual(['new'])
    expect(second?.epoch).not.toBe(firstEpoch)
  })

  it('treats clearing an unknown PTY as a no-op', () => {
    appendParkedTerminalPreviewOutput('pty-1', 'kept\n')
    clearParkedTerminalPreviewTail('pty-unknown')

    expect(getParkedTerminalPreviewTailCensus()).toEqual({ tails: 1, bytes: 4 })
  })

  it('tracks aggregate bytes across PTYs and through overwrites', () => {
    appendParkedTerminalPreviewOutput('pty-a', 'aaaa\n')
    appendParkedTerminalPreviewOutput('pty-b', 'bb\n')
    expect(getParkedTerminalPreviewTailCensus()).toEqual({ tails: 2, bytes: 6 })

    appendParkedTerminalPreviewOutput('pty-b', 'ccc\n')
    expect(getParkedTerminalPreviewTailCensus()).toEqual({ tails: 2, bytes: 9 })
  })

  it('evicts the least recently updated tails when the aggregate budget is exceeded', () => {
    const perTail = TERMINAL_PARKED_PREVIEW_TAIL_MAX_BYTES
    const tailsToFill = Math.ceil(TERMINAL_PARKED_PREVIEW_TAIL_AGGREGATE_MAX_BYTES / perTail) + 3
    const fill = `${'z'.repeat(perTail - 1)}\n`
    for (let index = 0; index < tailsToFill; index += 1) {
      appendParkedTerminalPreviewOutput(`pty-${index}`, fill, index)
    }
    const census = getParkedTerminalPreviewTailCensus()

    expect(census.bytes).toBeLessThanOrEqual(TERMINAL_PARKED_PREVIEW_TAIL_AGGREGATE_MAX_BYTES)
    expect(getParkedTerminalPreviewTail('pty-0')).toBeNull()
    expect(getParkedTerminalPreviewTail(`pty-${tailsToFill - 1}`)).not.toBeNull()
  })

  it('refreshes recency on write so an active PTY survives aggregate eviction', () => {
    const perTail = TERMINAL_PARKED_PREVIEW_TAIL_MAX_BYTES
    const capacity = Math.floor(TERMINAL_PARKED_PREVIEW_TAIL_AGGREGATE_MAX_BYTES / perTail)
    const fill = `${'z'.repeat(perTail - 1)}\n`
    for (let index = 0; index < capacity; index += 1) {
      appendParkedTerminalPreviewOutput(`pty-${index}`, fill)
    }
    // Why no newline: one byte keeps pty-0 inside its own 8 KB budget while refreshing recency.
    appendParkedTerminalPreviewOutput('pty-0', 'x')
    appendParkedTerminalPreviewOutput('pty-new', fill)

    expect(getParkedTerminalPreviewTail('pty-0')).not.toBeNull()
    expect(getParkedTerminalPreviewTail('pty-1')).toBeNull()
  })

  it('never evicts the tail currently being written', () => {
    appendParkedTerminalPreviewOutput('only', `${'q'.repeat(20_000)}\n`)

    expect(getParkedTerminalPreviewTail('only')).not.toBeNull()
  })

  it('resets cleanly for tests', () => {
    appendParkedTerminalPreviewOutput('pty-1', 'x\n')
    resetParkedTerminalPreviewTailsForTests()

    expect(getParkedTerminalPreviewTailCensus()).toEqual({ tails: 0, bytes: 0 })
  })
})
