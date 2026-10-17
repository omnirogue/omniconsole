import { describe, expect, it } from 'vitest'

import { binaryPathsFromEol, diffBaseline, parseBaseline } from './check-text-sources.mjs'

describe('parseBaseline', () => {
  it('keeps paths and drops comments and blank lines', () => {
    expect(parseBaseline('# why\n\nsrc/a.ts\n  src/b.ts  \n')).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('binaryPathsFromEol', () => {
  const text = 'i/lf    w/lf    attr/                 \tsrc/text.ts'
  const binary = 'i/-text w/-text attr/                 \tsrc/binary.ts'

  it('reports only the files git calls non-text', () => {
    expect(binaryPathsFromEol(`${text}\n${binary}\n`)).toEqual(['src/binary.ts'])
  })

  it('catches a file that is binary in the working tree only', () => {
    expect(binaryPathsFromEol('i/lf    w/-text attr/                 \tsrc/new.ts\n')).toEqual([
      'src/new.ts'
    ])
  })

  it('does not mistake a path containing "-text" for a verdict', () => {
    expect(
      binaryPathsFromEol('i/lf    w/lf    attr/                 \tsrc/help-text.ts\n')
    ).toEqual([])
  })
})

describe('diffBaseline', () => {
  it('reports new binary files and baseline entries that are text again', () => {
    expect(diffBaseline(['src/a.ts', 'src/new.ts'], ['src/a.ts', 'src/gone.ts'])).toEqual({
      added: ['src/new.ts'],
      fixed: ['src/gone.ts']
    })
  })
})
