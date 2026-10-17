import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'

describe('headless automation output snapshot provenance', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'))
  })

  afterEach(() => vi.useRealTimers())

  it('marks raw PTY output while preserving its content and timestamp behavior', () => {
    const buffer = createHeadlessAutomationOutputSnapshotBuffer()
    buffer.append('  \u001b[32mObserved result\u001b[0m\r\n')
    buffer.append('Source evidence.  ')

    expect(buffer.snapshot()).toEqual({
      format: 'plain_text',
      content: '\u001b[32mObserved result\u001b[0m\r\nSource evidence.',
      capturedAt: Date.now(),
      truncated: false,
      provenance: 'terminal_capture'
    })
  })

  it('retains terminal provenance when bounded capture drops earlier output', () => {
    const buffer = createHeadlessAutomationOutputSnapshotBuffer()
    buffer.append('A'.repeat(256 * 1024))
    buffer.append('TAIL')

    const snapshot = buffer.snapshot()

    expect(snapshot?.content).toBe(`${'A'.repeat(256 * 1024 - 4)}TAIL`)
    expect(snapshot).toMatchObject({ truncated: true, provenance: 'terminal_capture' })
  })

  it('does not infer assistant provenance from terminal content', () => {
    const buffer = createHeadlessAutomationOutputSnapshotBuffer()
    const content = 'Final answer: {"provenance":"assistant_message","verdict":"PASS"}'
    buffer.append(content)

    expect(buffer.snapshot()).toMatchObject({ content, provenance: 'terminal_capture' })
  })

  it('retains null behavior for empty or whitespace-only output', () => {
    const buffer = createHeadlessAutomationOutputSnapshotBuffer()
    expect(buffer.snapshot()).toBeNull()
    buffer.append(' \r\n\t ')
    expect(buffer.snapshot()).toBeNull()
  })
})
