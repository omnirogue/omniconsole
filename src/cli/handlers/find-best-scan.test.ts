import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { HandlerContext } from '../dispatch'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from '../args'
import { COMMAND_SPECS } from '../specs'
import { FIND_BEST_HANDLERS, findRequestFromFlags, validateFindSources } from './find-best'

// Source conflicts are rejected before reading files.
describe('Find Scan flags', () => {
  it('parses --file as a value flag', () => {
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(
        ['find-best', 'Best', '--file', 'source'],
        COMMAND_SPECS.map((spec) => spec.path)
      )
    )
    validateCommandAndFlags(COMMAND_SPECS, parsed)
    expect(parsed.flags.get('file')).toBe('source')
    expect(findRequestFromFlags(parsed.flags).prompt).toBe('Best')
  })
  it.each([
    ['file', 'list'],
    ['file', 'versions']
  ])('refuses --%s with --%s', (left, right) => {
    expect(() =>
      validateFindSources(
        new Map([
          [left, 'x'],
          [right, '2']
        ])
      )
    ).toThrow('choose one source')
  })
  it('requires a value for --file', () => {
    expect(() => validateFindSources(new Map([['file', true]]))).toThrow('needs a value')
  })
  it('keeps imported details in the validated request', () => {
    const items = [{ title: 'A', detail: 'More', url: 'https://example.com' }, 'B']
    expect(
      findRequestFromFlags(
        new Map([
          ['prompt', 'Best'],
          ['file', 'list.json']
        ]),
        items
      ).items
    ).toEqual(items)
  })
})

vi.mock('../selectors', () => ({ getOptionalWorktreeSelector: async () => 'id:workspace' }))
afterEach(() => vi.restoreAllMocks())

describe('Scan CLI imports', () => {
  const run = async (source: string, value: string, call: ReturnType<typeof vi.fn>) => {
    const flags = new Map<string, string | boolean>([
      ['prompt', 'Best'],
      [source, value],
      ['no-follow', true]
    ])
    return FIND_BEST_HANDLERS['find-best']!({
      flags,
      cwd: process.cwd(),
      client: { call },
      json: false
    } as unknown as HandlerContext)
  }
  it('reads CSV, passes structured options and reports skipped rows', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'find-scan-'))
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn().mockResolvedValue({ result: { executionId: 'run' } })
    try {
      const path = join(folder, 'options.csv')
      await writeFile(path, 'title,detail\nA,first\n,missing\nB,second')
      await run('file', path, call)
      expect(call).toHaveBeenCalledWith(
        'localWorkflow.find',
        expect.objectContaining({
          request: expect.objectContaining({
            prompt: 'Best',
            items: [
              { title: 'A', detail: 'first' },
              { title: 'B', detail: 'second' }
            ],
            importReceipt: {
              read: 3,
              imported: 2,
              skipped: [{ line: 2, reason: 'no title' }],
              merged: 0
            }
          })
        }),
        expect.anything()
      )
      expect(stderr).toHaveBeenCalledWith('Imported 2 options; skipped 1 rows.\n')
      await writeFile(path, 'a'.repeat(1024 * 1024 + 1))
      await expect(run('file', path, call)).rejects.toThrow('larger than 1 MB')
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
