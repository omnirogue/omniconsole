import { describe, expect, it } from 'vitest'
import { liveTailSegments } from './workflow-live-tail'

const shown = (tail: string) =>
  liveTailSegments(tail).map(({ text, style }) => (style ? { text, style } : { text }))

/**
 * Why these tests exist: live acceptance showed Codex's reasoning tail with raw markers,
 * "**Identifying concurrency and security flaws**", on every Council answer card.
 */
describe('liveTailSegments', () => {
  it('reads Codex reasoning headings as bold lines, without their markers', () => {
    expect(
      shown('**Identifying flaws**\n\nI see a race.\n\n**Detecting risks**\n**Reviewing commits**')
    ).toEqual([
      { text: 'Identifying flaws', style: 'strong' },
      { text: '\n\nI see a race.\n\n' },
      { text: 'Detecting risks', style: 'strong' },
      { text: '\n' },
      { text: 'Reviewing commits', style: 'strong' }
    ])
  })

  it('reads bold and code spans inside a line and headings as bold', () => {
    expect(shown('## Findings\nThe **save** in `reserve.ts` is unawaited.')).toEqual([
      { text: 'Findings', style: 'strong' },
      { text: '\nThe ' },
      { text: 'save', style: 'strong' },
      { text: ' in ' },
      { text: 'reserve.ts', style: 'code' },
      { text: ' is unawaited.' }
    ])
  })

  it('drops a marker the stream or the cut left alone, and keeps one mid-line', () => {
    // Still streaming: the closing ** has not arrived yet.
    expect(shown('Done.\n**Checking the cac')).toEqual([
      { text: 'Done.\n' },
      { text: 'Checking the cac', style: 'strong' }
    ])
    // The ~2 KB cut fell inside a bold heading: only its closing ** is left.
    expect(shown('security flaws**\nNext')).toEqual([
      { text: 'security flaws', style: 'strong' },
      { text: '\nNext' }
    ])
    expect(shown('Globs such as src/**/*.ts stay as written')).toEqual([
      { text: 'Globs such as src/**/*.ts stay as written' }
    ])
  })

  it('reads a bold span the model wrapped over lines as bold on each line', () => {
    expect(shown('**Identifying concurrency\nand security flaws**\nI see a race.')).toEqual([
      { text: 'Identifying concurrency', style: 'strong' },
      { text: '\n' },
      { text: 'and security flaws', style: 'strong' },
      { text: '\nI see a race.' }
    ])
    expect(shown('**One\ntwo\nthree**')).toEqual([
      { text: 'One', style: 'strong' },
      { text: '\n' },
      { text: 'two', style: 'strong' },
      { text: '\n' },
      { text: 'three', style: 'strong' }
    ])
    // A span never closed stays on its own line: the next line is not swallowed into it.
    expect(shown('**kwargs is how\nPython passes them')).toEqual([
      { text: 'kwargs is how', style: 'strong' },
      { text: '\nPython passes them' }
    ])
  })

  it('keeps a span with a star of its own as written, so two globs on a line stay globs', () => {
    expect(shown('Match src/**/*.ts and lib/**/*.js here')).toEqual([
      { text: 'Match src/**/*.ts and lib/**/*.js here' }
    ])
    expect(shown('**a*b**')).toEqual([{ text: '**a*b**' }])
  })

  it('gives every segment a distinct key', () => {
    const offsets = liveTailSegments('a **b** c `d` e').map((segment) => segment.offset)
    expect(new Set(offsets).size).toBe(offsets.length)
  })
})
