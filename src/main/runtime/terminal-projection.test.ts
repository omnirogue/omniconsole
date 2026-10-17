import { describe, expect, it } from 'vitest'
import type { TerminalCursorContext } from '../../shared/terminal-composer-draft'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { projectTerminalTailLines, projectVisibleTerminalLines } from './omni-runtime'
import { readScreenEvidence } from './terminal-agent-evidence'
import {
  readCodexRecapDecorations,
  remapTerminalScreenDecorations
} from '../../shared/terminal-codex-recap'

const recap = (body: string) => `\x1b[2;3m  ↳ \x1b[1mRecap:\x1b[22;2m ${body}\x1b[0m`
const continuation = (body: string) => `\x1b[2;3m           ${body}\x1b[0m`
const detectors = { blockedReason: () => null, readyPrompt: () => false }

describe('projectTerminalTailLines', () => {
  it('recognizes only the styled closing recap, retaining older equal recap text at its own rows', async () => {
    const emulator = new HeadlessEmulator({ cols: 256, rows: 78, scrollback: 0 })
    const body = 'A'.repeat(238)
    const rest = 'B'.repeat(129)
    try {
      await emulator.write(
        [
          '\x1b[?1049h',
          `\x1b[3;1H${recap(body)}`,
          `\x1b[4;1H${continuation(rest)}`,
          '\x1b[8;1H› Reply with ACK.',
          '\x1b[10;1H• ACK',
          '\x1b[12;1H3:00 PM',
          `\x1b[14;1H${recap(body)}`,
          `\x1b[15;1H${continuation(rest)}`,
          '\x1b[17;1HTip: Use /help.',
          '\x1b[19;1H\x1b[1m›\x1b[0;2m Ask Codex to do anything',
          '\x1b[21;1Hgpt-6-astra medium · ~/workspace',
          '\x1b[22;1H? for shortcuts',
          '\x1b[0m'
        ].join('')
      )
      const projected = projectVisibleTerminalLines(emulator)
      expect(projected.screenDecorations).toEqual([
        { kind: 'codex-recap', startRow: 0, endRow: 1 },
        { kind: 'codex-recap', startRow: 5, endRow: 6 }
      ])
      expect(
        readScreenEvidence(projected.lines, detectors, 'ACK', projected.screenDecorations)
      ).toMatchObject({
        readyPrompt: true,
        turnDone: true,
        working: false
      })
      expect(
        readScreenEvidence(
          projected.lines,
          detectors,
          'ACK',
          projected.screenDecorations?.slice(0, 1)
        ).readyPrompt
      ).toBe(false)
      expect(readScreenEvidence(projected.lines, detectors, 'ACK').readyPrompt).toBe(false)
      expect(
        readScreenEvidence(projected.lines, detectors, 'OLD', projected.screenDecorations)
          .readyPrompt
      ).toBe(false)
    } finally {
      emulator.dispose()
    }
  })

  it.each([
    ['queued arrow is not italic', '\x1b[2m  ↳ \x1b[3;1mRecap:\x1b[22;2m done\x1b[0m'],
    ['plain text', '  ↳ Recap: done'],
    ['nonbold label', '\x1b[2;3m  ↳ Recap: done\x1b[0m'],
    ['bold ordinary body', '\x1b[2;3m  ↳ \x1b[1mRecap: done\x1b[0m'],
    ['wrong continuation indent', `${recap('done')}\r\n\x1b[2;3m    more\x1b[0m`],
    ['wide glyph enters reserved RHS', recap(`${'a'.repeat(66)}界`)],
    ['overlong summary', recap('a'.repeat(701))],
    ['clipped at bottom', `\x1b[24;1H${recap('done')}`]
  ])('refuses an unproven recap shape: %s', async (_name, ansi) => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 0 })
    try {
      await emulator.write(`\x1b[?1049h${ansi}`)
      expect(readCodexRecapDecorations(emulator.getScreenCellSource())).toEqual([])
    } finally {
      emulator.dispose()
    }
  })

  it('allows a bounded styled Next label, but rejects an overlong action', async () => {
    const emulator = new HeadlessEmulator({ cols: 256, rows: 24, scrollback: 0 })
    try {
      await emulator.write(
        `\x1b[?1049h${recap('The checks finished.')}\r\n${continuation('\x1b[1mNext:\x1b[22;2m Inspect the report.')}`
      )
      expect(readCodexRecapDecorations(emulator.getScreenCellSource())).toEqual([
        { kind: 'codex-recap', startRow: 0, endRow: 1 }
      ])
      await emulator.write(`\x1b[2;1H${continuation(`\x1b[1mNext:\x1b[22;2m ${'a'.repeat(201)}`)}`)
      expect(readCodexRecapDecorations(emulator.getScreenCellSource())).toEqual([])
    } finally {
      emulator.dispose()
    }
  })

  it('drops recap evidence when the same frame has a typed composer draft', async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 0 })
    const draft = 'Recap: untouched draft'
    try {
      await emulator.write(
        `\x1b[?1049h${recap('Finished.')}\x1b[5;1H\x1b[1m›\x1b[0m ${draft}\x1b[7;1H\x1b[2mgpt-6-astra · ~/workspace\x1b[0m\x1b[5;${3 + draft.length}H`
      )
      const projection = projectVisibleTerminalLines(emulator)
      expect(projection.draft).toBe(draft)
      expect(projection.screenDecorations).toBeUndefined()
    } finally {
      emulator.dispose()
    }
  })

  it('marks Claude’s dim suggested prompt, but not typed text, as suggested', async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 8, scrollback: 0 })
    try {
      // Bytes Claude drew on the Studio: a dim suggestion right of an empty prompt, cursor before it.
      await emulator.write(
        '────────\r\n❯\u00a0\x1b[2msend the gamma credits\x1b[22m\r\n────────\x1b[2;3H'
      )
      expect(projectVisibleTerminalLines(emulator)).toMatchObject({
        lines: ['────────', '❯', '────────'],
        draft: 'send the gamma credits',
        draftSuggested: true
      })
      await emulator.write('\x1b[2;3H\x1b[Ksend the gamma credits')
      const typed = projectVisibleTerminalLines(emulator)
      expect(typed.draft).toBe('send the gamma credits')
      expect(typed.draftSuggested).toBeUndefined()
    } finally {
      emulator.dispose()
    }
  })

  it('drops invalid or partially filtered decoration ranges instead of matching their text elsewhere', () => {
    const valid = { kind: 'codex-recap' as const, startRow: 2, endRow: 3 }
    expect(remapTerminalScreenDecorations([valid], [0, 2, 3, 5])).toEqual([
      { ...valid, startRow: 1, endRow: 2 }
    ])
    for (const indexes of [
      [0, 3, 5],
      [0, 2, 5],
      [5, 6, 7]
    ]) {
      expect(remapTerminalScreenDecorations([valid], indexes)).toEqual([])
    }
    for (const patch of [{ startRow: -1 }, { endRow: 2.5 }, { endRow: 1 }, { endRow: Infinity }]) {
      expect(remapTerminalScreenDecorations([{ ...valid, ...patch }], [0, 1, 2, 3])).toEqual([])
    }
  })

  it('does not splice a scrolled viewport into unrelated tail rows', () => {
    const context: TerminalCursorContext = {
      rows: ['────────', '❯ proceed'],
      typedRows: ['────────', '❯'],
      promptGlyphBoldRows: [false, false],
      rowsBelow: [],
      typedRowsBelow: [],
      beforeCursor: '❯ ',
      afterCursor: '',
      rawAfterCursor: 'proceed',
      cursorHidden: false,
      cursorViewportRow: 1
    }
    const emulator = {
      getBufferTailLines: () => ['old output', 'tail output'],
      getVisibleLines: () => ['────────', '❯ proceed'],
      getVisibleBufferRange: () => ({ start: 0, endExclusive: 2, totalLength: 10 }),
      getCursorLineContext: () => context
    } as unknown as HeadlessEmulator

    expect(projectTerminalTailLines(emulator, 2)).toEqual({
      lines: ['old output', 'tail output'],
      draft: 'proceed',
      draftSuggested: true
    })
  })

  it('backfills the prompt row when a small limit contains only draft continuations', () => {
    const context: TerminalCursorContext = {
      rows: ['────────', '❯ proceed'],
      typedRows: ['────────', '❯'],
      promptGlyphBoldRows: [false, false],
      rowsBelow: [' with', ' release'],
      typedRowsBelow: ['', ''],
      rowsBelowWrapped: [true, true],
      beforeCursor: '❯ ',
      afterCursor: '',
      rawAfterCursor: 'proceed',
      cursorHidden: false,
      cursorViewportRow: 2
    }
    const emulator = {
      getBufferTailLines: () => [' with', ' release'],
      getVisibleLines: () => ['Build passed', '────────', '❯ proceed', ' with', ' release'],
      getVisibleBufferRange: () => ({ start: 0, endExclusive: 5, totalLength: 5 }),
      getCursorLineContext: () => context
    } as unknown as HeadlessEmulator

    expect(projectTerminalTailLines(emulator, 2)).toEqual({
      lines: ['────────', '❯'],
      draft: 'proceed with release',
      draftSuggested: true
    })
  })
})
