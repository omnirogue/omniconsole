import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deriveGeneratedTabTitle,
  GENERATED_TAB_TITLE_MAX_LENGTH,
  GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT
} from './agent-tab-title'
import { SESSION_PROMPT_CONTEXT_SCAN_LIMIT } from './session-prompt-content'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('deriveGeneratedTabTitle', () => {
  it('derives a short title from the first useful prompt clause', () => {
    expect(
      deriveGeneratedTabTitle('Can you please refactor the auth middleware to use JWT tokens?')
    ).toBe('Refactor the auth middleware to use JWT')
  })

  it('strips markup, links, emoji, and punctuation without promoting incidental markers', () => {
    expect(
      deriveGeneratedTabTitle(
        'Please fix auth note #1 with `src/auth.ts`!!! https://example.com 🔥'
      )
    ).toBe('Fix auth note 1 with src auth')
  })

  it('preserves non-ASCII title text while folding Unicode whitespace', () => {
    expect(deriveGeneratedTabTitle('Please 修正\u00a0résumé\t検索\u3000１２３!!!')).toBe(
      '修正 résumé 検索 １２３'
    )
  })

  it('keeps useful text after common issue prefixes', () => {
    expect(deriveGeneratedTabTitle('Issue #2056: Opt-in generated tab titles for agents')).toBe(
      'Opt in generated tab titles for agents'
    )
  })

  it('strips a URL containing underscores intact', () => {
    expect(
      deriveGeneratedTabTitle('inspect https://gitlab.com/g/p/-/work_items/9 then report')
    ).toBe('Inspect then report')
  })

  it('strips a URL wrapped in markdown emphasis without leaking fragments', () => {
    const title = deriveGeneratedTabTitle('Review _https://github.com/o/r/pull/5_ now')
    expect(title).toBe('Review now')
    expect(title).not.toMatch(/https|pull/)
  })

  it('drops image placeholders without changing ordinary image references', () => {
    expect(deriveGeneratedTabTitle('[Image #1] Fix the session list')).toBe('Fix the session list')
    expect(deriveGeneratedTabTitle('Tell me where this is [Image #1] then explain')).toBe(
      'Tell me where this is then explain'
    )
    expect(deriveGeneratedTabTitle('[Image #1]')).toBeNull()
    expect(deriveGeneratedTabTitle('Image 1 has an incorrect caption')).toBe(
      'Image 1 has an incorrect caption'
    )
  })

  it('selects the brief after a long exact launcher context wrapper', () => {
    const prompt =
      `# Launch context (added by omni-launch-best; estate context)\n\n${'Company and domain context.\n'.repeat(
        400
      )}Start here: \`slite-kb brief --scope shared --division ops\` for this company and department, and \`wis knowledge search --q "<task terms>"\` for estate history.\n\n` +
      `[Image #1] Fix keyboard delivery`
    expect(deriveGeneratedTabTitle(prompt)).toBe('Fix keyboard delivery')
  })

  it('selects the requested result from known launch brief headings', () => {
    expect(
      deriveGeneratedTabTitle(
        '# Prepared launch brief\n\n## Launch folder and role\nSome setup context.\n\n## Requested result\nFix keyboard delivery'
      )
    ).toBe('Fix keyboard delivery')
    expect(
      deriveGeneratedTabTitle(
        '# SSH launch readiness — mw0001\n\nRequested result: prove the execution machine'
      )
    ).toBe('Prove the execution machine')
    expect(deriveGeneratedTabTitle('## Requested result\nFix keyboard delivery')).toBe(
      'Fix keyboard delivery'
    )
  })

  it('skips a shipped role profile before the actual brief heading', () => {
    expect(
      deriveGeneratedTabTitle(
        'Role brief:\n# Role: coder\n\nFollow the project rules.\n\n# Fix keyboard delivery\n\nRequested result: fix delivery'
      )
    ).toBe('Fix keyboard delivery')
  })

  it('does not invent a title from missing or oversized launch context boundaries', () => {
    const header = '# Launch context (added by omni-launch-best; estate context)\n'
    expect(deriveGeneratedTabTitle(`${header}## Company rules\nFollow policy`)).toBeNull()
    expect(
      deriveGeneratedTabTitle(
        `${
          header + 'x'.repeat(SESSION_PROMPT_CONTEXT_SCAN_LIMIT)
        }\nStart here: \`slite-kb brief --scope shared --division ops\` for this company and department, and \`wis knowledge search --q "<task terms>"\` for estate history.\nFix delivery`
      )
    ).toBeNull()
    expect(
      deriveGeneratedTabTitle('Role brief:\n# Role: coder\nFollow the project rules.')
    ).toBeNull()
    expect(deriveGeneratedTabTitle('# Prepared launch brief\nNo requested result.')).toBeNull()
  })

  it('preserves the person’s heading and wording when they are not scaffolding', () => {
    expect(deriveGeneratedTabTitle('# Launch context investigation')).toBe(
      'Launch context investigation'
    )
    expect(deriveGeneratedTabTitle('Requested result was incorrect')).toBe(
      'Requested result was incorrect'
    )
    expect(deriveGeneratedTabTitle('It makes zero sense that when i start a session')).toBe(
      'It makes zero sense that when i start a'
    )
  })

  it('bounds titles to the maximum length without adding punctuation', () => {
    const title = deriveGeneratedTabTitle(
      'I want to replace the terminal reconnection hydration flow with a safer retry path'
    )

    expect(title).toBeTruthy()
    expect(title!.length).toBeLessThanOrEqual(GENERATED_TAB_TITLE_MAX_LENGTH)
    expect(title).toMatch(/^[\p{L}\p{N}\s]+$/u)
  })

  it('returns null when the prompt has no useful title text', () => {
    expect(deriveGeneratedTabTitle('please!!!')).toBeNull()
  })

  it('bounds normalization work for paste-sized prompts before truncating the title', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const prompt = `Please fix \`src/auth.ts\` ${'large pasted text '.repeat(5000)}`

    const title = deriveGeneratedTabTitle(prompt)

    expect(title).toBeTruthy()
    expect(title!.length).toBeLessThanOrEqual(GENERATED_TAB_TITLE_MAX_LENGTH)
    const replaceContextLengths = replaceSpy.mock.contexts.map((context) => String(context).length)
    const splitContextLengths = splitSpy.mock.contexts.map((context) => String(context).length)
    expect(Math.max(...replaceContextLengths)).toBeLessThanOrEqual(
      GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT
    )
    expect(Math.max(...splitContextLengths)).toBeLessThanOrEqual(
      GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT
    )
    expect(
      replaceSpy.mock.calls.filter(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
      )
    ).toHaveLength(0)
  })
})
