import { describe, expect, it } from 'vitest'
import { createBoundedTerminalStream } from './terminal-stream'

describe('createBoundedTerminalStream', () => {
  it('exposes only the versioned transcript snapshot', () => {
    const stream = createBoundedTerminalStream()
    stream.append('\u001b[3')

    expect(stream.snapshot()).toEqual({
      version: 1,
      lines: [],
      previewLines: [],
      partialLine: '',
      completedLineCount: 0,
      truncated: false
    })
  })

  it('commits the latest carriage-return and backspace redraw', () => {
    const stream = createBoundedTerminalStream()
    stream.append('boot\r\nstage old\rreadyX\u0008!\n')

    expect(stream.snapshot()).toEqual({
      version: 1,
      lines: ['boot', 'ready!'],
      previewLines: ['boot', 'ready!'],
      partialLine: '',
      completedLineCount: 2,
      truncated: false
    })
  })

  it('preserves committed lines when a vertical redraw replaces the preview', () => {
    const stream = createBoundedTerminalStream()
    stream.append('alpha\nprogress old\n')
    stream.append('\u001b[1A\r')
    stream.append('\u001b[2Kprogress new\n')

    expect(stream.snapshot()).toEqual({
      version: 1,
      lines: ['alpha', 'progress old', 'progress new'],
      previewLines: ['alpha', 'progress new'],
      partialLine: '',
      completedLineCount: 3,
      truncated: false
    })
  })

  it('handles CSI and OSC terminators split across chunks without leaking their payload', () => {
    const stream = createBoundedTerminalStream()
    stream.append('\u001b[3')
    stream.append('1mred\u001b[0m\nbefore\u001b]0;private-title')
    expect(stream.snapshot().partialLine).toBe('before')
    stream.append('\u001b')
    stream.append('\\after\n')

    expect(stream.snapshot()).toEqual({
      version: 1,
      lines: ['red', 'beforeafter'],
      previewLines: ['red', 'beforeafter'],
      partialLine: '',
      completedLineCount: 2,
      truncated: false
    })
  })

  it('retains the newest 2000 lines while preserving the absolute completion count', () => {
    const stream = createBoundedTerminalStream()
    stream.append(Array.from({ length: 2005 }, (_, index) => `line ${index}\n`).join(''))

    const snapshot = stream.snapshot()
    expect(snapshot.lines).toHaveLength(2000)
    expect(snapshot.lines[0]).toBe('line 5')
    expect(snapshot.lines.at(-1)).toBe('line 2004')
    expect(snapshot.previewLines).toEqual(snapshot.lines)
    expect(snapshot.completedLineCount).toBe(2005)
    expect(snapshot.truncated).toBe(true)

    stream.append('line 2005\n')
    expect(stream.snapshot().lines[0]).toBe('line 6')
    expect(stream.snapshot().completedLineCount).toBe(2006)
  })

  it('caps committed characters at 256 KiB without resetting the absolute line count', () => {
    const stream = createBoundedTerminalStream()
    const lines = Array.from(
      { length: 300 },
      (_, index) => `row:${String(index).padStart(3, '0')}:${'x'.repeat(1016)}`
    )
    stream.append(`${lines.join('\n')}\n`)

    const snapshot = stream.snapshot()
    expect(snapshot.lines).toHaveLength(256)
    expect(snapshot.lines[0]).toBe(`row:044:${'x'.repeat(1016)}`)
    expect(snapshot.lines.at(-1)).toBe(`row:299:${'x'.repeat(1016)}`)
    expect(snapshot.lines.reduce((sum, line) => sum + line.length, 0)).toBe(256 * 1024)
    expect(snapshot.previewLines).toEqual(snapshot.lines)
    expect(snapshot.completedLineCount).toBe(300)
    expect(snapshot.truncated).toBe(true)
  })

  it('preserves Unicode text including a surrogate pair split across chunks', () => {
    const stream = createBoundedTerminalStream()
    stream.append('café 雪 \ud83d')
    stream.append('\ude80\nनमस्ते\n')

    expect(stream.snapshot().lines).toEqual(['café 雪 🚀', 'नमस्ते'])
    expect(stream.snapshot().completedLineCount).toBe(2)
    expect(stream.snapshot().truncated).toBe(false)
  })

  it.each(['', '\u001b', '\u001b[', '\u001b]0;unfinished'])(
    'finishes unterminated JSON despite a dangling control %j and ignores later appends',
    (suffix) => {
      const stream = createBoundedTerminalStream()
      stream.append(`{"ok":true}${suffix}`)
      expect(stream.snapshot().lines).toEqual([])
      stream.finish()

      const finished = stream.snapshot()
      expect(finished).toEqual({
        version: 1,
        lines: ['{"ok":true}'],
        previewLines: ['{"ok":true}'],
        partialLine: '',
        completedLineCount: 1,
        truncated: false
      })
      expect(JSON.parse(JSON.stringify(finished))).toEqual(finished)

      stream.finish()
      stream.append('ignored\n')
      expect(stream.snapshot()).toEqual(finished)
    }
  )

  it.each([
    { chunk: '', lines: [] },
    { chunk: '\n', lines: [''] },
    { chunk: 'done\n', lines: ['done'] }
  ])('finishes %j without adding an empty completion', ({ chunk, lines }) => {
    const stream = createBoundedTerminalStream()
    stream.append(chunk)
    stream.finish()
    stream.finish()

    expect(stream.snapshot().lines).toEqual(lines)
    expect(stream.snapshot().completedLineCount).toBe(lines.length)
    expect(stream.snapshot().partialLine).toBe('')
  })

  it('commits only the bounded partial line at EOF and keeps truncation visible', () => {
    const stream = createBoundedTerminalStream()
    stream.append('x'.repeat(4500))
    expect(stream.snapshot().partialLine).toHaveLength(4000)
    expect(stream.snapshot().completedLineCount).toBe(0)
    stream.finish()

    expect(stream.snapshot().lines).toEqual(['x'.repeat(4000)])
    expect(stream.snapshot().completedLineCount).toBe(1)
    expect(stream.snapshot().partialLine).toBe('')
    expect(stream.snapshot().truncated).toBe(true)
  })

  it('isolates returned snapshots from later writes and caller mutation', () => {
    const stream = createBoundedTerminalStream()
    stream.append('first\npartial')
    const before = stream.snapshot()
    stream.append(' end\n')

    expect(before.lines).toEqual(['first'])
    expect(before.previewLines).toEqual(['first'])
    expect(before.partialLine).toBe('partial')
    expect(before.completedLineCount).toBe(1)

    const after = stream.snapshot()
    after.lines[0] = 'changed'
    after.lines.push('injected')
    after.previewLines.splice(0)
    after.partialLine = 'injected partial'
    after.completedLineCount = -1

    expect(stream.snapshot()).toEqual({
      version: 1,
      lines: ['first', 'partial end'],
      previewLines: ['first', 'partial end'],
      partialLine: '',
      completedLineCount: 2,
      truncated: false
    })
  })
})
