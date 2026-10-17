import { describe, expect, it } from 'vitest'
import { createOutputSink } from './bounded-output-sink'

describe('capture completeness', () => {
  it.each(['head', 'tail'] as const)('reports discarded bytes for %s capture', (capture) => {
    const sink = createOutputSink(4, capture)
    sink.write('abcd')
    expect(sink.truncated()).toBe(false)
    sink.write('e')
    expect(sink.truncated()).toBe(true)
    expect(sink.text()).toBe(capture === 'head' ? 'abcd' : 'bcde')
  })
  it('preserves UTF-8 split across chunks and measures bytes', () => {
    const bytes = Buffer.from('a😀')
    const sink = createOutputSink(bytes.length)
    sink.write(bytes.subarray(0, 3))
    sink.write(bytes.subarray(3))
    expect(sink.text()).toBe('a😀')
    expect(sink.truncated()).toBe(false)
    sink.write('!')
    expect(sink.truncated()).toBe(true)
  })
  it('reports overflow with zero retention', () => {
    const sink = createOutputSink(0)
    sink.write('x')
    expect(sink.text()).toBe('')
    expect(sink.truncated()).toBe(true)
  })
})
