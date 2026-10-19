import { describe, expect, it } from 'vitest'
import {
  extractDoneWhenOutputs,
  extractMissionOutputs,
  extractReplyClaims,
  extractRequestedOutputs,
  replyAsksPerson
} from './deliverable-claims'

const targets = (items: { target: string }[]): string[] => items.map((item) => item.target)

describe('extractRequestedOutputs', () => {
  it('takes the output path of a real request and not the folder it inspects', () => {
    const prompt =
      'First run `mkdir -p /Users/maintainer/Work/Ops/Plans/Wave22`. Inspect /Users/maintainer/Work/omni-ide and design a built-in verifier at /Users/maintainer/Work/Ops/Plans/Wave22/W22-20-Spec.md.'
    expect(targets(extractRequestedOutputs(prompt))).toEqual([
      '/Users/maintainer/Work/Ops/Plans/Wave22/W22-20-Spec.md'
    ])
  })

  it('reads save-to, write-into and create-a-file phrasings', () => {
    const prompt = [
      'Save the report to `reports/october.md`.',
      'Write the summary into docs/summary.txt please.',
      'Create a file `notes.md` with the findings.'
    ].join('\n')
    expect(targets(extractRequestedOutputs(prompt))).toEqual([
      'reports/october.md',
      'docs/summary.txt',
      'notes.md'
    ])
  })

  it('ignores paths to read, fenced code, commands and negated outputs', () => {
    const prompt = [
      'Read src/main/index.ts and explain it.',
      "Don't write anything to docs/out.md.",
      '```',
      'echo hi > build/out.txt',
      '```',
      '$ cp a.md b.md'
    ].join('\n')
    expect(extractRequestedOutputs(prompt)).toEqual([])
  })

  it('reads Windows paths', () => {
    expect(
      targets(extractRequestedOutputs('Save it to C:\\Users\\sal\\Desktop\\plan.docx today.'))
    ).toEqual(['C:\\Users\\sal\\Desktop\\plan.docx'])
  })
})

describe('extractReplyClaims', () => {
  it('reads past-tense claims with backticked, absolute and relative paths', () => {
    const reply = [
      'I saved the spec to `/Users/maintainer/Plans/Spec.md`.',
      'Updated src/shared/settings.ts and created docs/guide.md.'
    ].join('\n')
    expect(extractReplyClaims(reply)).toEqual([
      { target: '/Users/maintainer/Plans/Spec.md', kind: 'file', claim: 'created' },
      { target: 'src/shared/settings.ts', kind: 'file', claim: 'updated' },
      { target: 'docs/guide.md', kind: 'file', claim: 'updated' }
    ])
  })

  it('carries a lead-in claim into its list items', () => {
    const reply = [
      'I created these files:',
      '- `src/a.ts`',
      '- `src/b.ts`',
      '',
      '- `src/c.ts`'
    ].join('\n')
    expect(targets(extractReplyClaims(reply))).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('ignores future, conditional, passive-modal and question sentences', () => {
    const reply = [
      'Next I will create `docs/next.md`.',
      'If approved, the page will be published at https://omnios.example.com/a/abcdef123.',
      '`docs/later.md` should be updated after review.',
      'Have you saved `notes.md`?'
    ].join('\n')
    expect(extractReplyClaims(reply)).toEqual([])
  })

  it('keeps a claim followed by a purpose clause', () => {
    expect(targets(extractReplyClaims('I created `review.md` so you can read it.'))).toEqual([
      'review.md'
    ])
  })

  it('marks explicit declines', () => {
    const [item] = extractReplyClaims(
      "I couldn't write `docs/deploy.md` because the folder is read-only."
    )
    expect(item).toMatchObject({ target: 'docs/deploy.md', claim: 'created' })
    expect(item?.declined).toContain("couldn't write")
  })

  it('reads artifact and plain links, trimming punctuation', () => {
    const reply =
      'Published the review page: https://console.example.com/a/1a14bca1e4b66edc1. Also posted https://github.com/o/r/pull/12).'
    expect(extractReplyClaims(reply)).toEqual([
      {
        target: 'https://console.example.com/a/1a14bca1e4b66edc1',
        kind: 'artifact',
        claim: 'published'
      },
      { target: 'https://github.com/o/r/pull/12', kind: 'url', claim: 'published' }
    ])
  })

  it('skips fenced code, commands, globs, placeholders and line suffixes', () => {
    const reply = [
      'Wrote the change in `src/a.ts:42`.',
      '```ts',
      '// created src/fake.ts',
      '```',
      'Updated `src/*.ts` and `<path>` and `pnpm test src/x.test.ts`.'
    ].join('\n')
    expect(targets(extractReplyClaims(reply))).toEqual(['src/a.ts'])
  })

  it('reads a markdown link to a file and a directory path', () => {
    expect(
      extractReplyClaims('Created [the plan](docs/plan.md) and the folder `out/reports/`.')
    ).toEqual([
      { target: 'docs/plan.md', kind: 'file', claim: 'created' },
      { target: 'out/reports/', kind: 'directory', claim: 'created' }
    ])
  })

  it('reads backticked absolute paths with spaces', () => {
    expect(
      targets(
        extractReplyClaims(
          'Saved it to `/Users/maintainer/Library/Application Support/omni/report.md` for you.'
        )
      )
    ).toEqual(['/Users/maintainer/Library/Application Support/omni/report.md'])
  })

  it('does not read a status label without a verb as a claim', () => {
    expect(extractReplyClaims('- **Spec:** `/Users/maintainer/Plans/Spec.md`')).toEqual([])
  })
})

describe('extractDoneWhenOutputs', () => {
  it('reads path items under a Done when heading', () => {
    const prompt = [
      '# Task',
      'Do the thing.',
      '## Done when',
      '- `reports/summary.md` exists in the task folder',
      '- pnpm tc passes',
      '## Constraints',
      '- never touch `secret.md`'
    ].join('\n')
    expect(targets(extractDoneWhenOutputs(prompt))).toEqual(['reports/summary.md'])
  })

  it('is empty without the section', () => {
    expect(extractDoneWhenOutputs('Write `a.md`.')).toEqual([])
  })
})

describe('extractMissionOutputs', () => {
  it('reads paths with extensions from mission text', () => {
    expect(
      targets(extractMissionOutputs(['Publish the review page', 'Write docs/plan.md for Sal']))
    ).toEqual(['docs/plan.md'])
  })
})

describe('replyAsksPerson', () => {
  it('sees a closing question or an offer', () => {
    expect(replyAsksPerson('Done with part one. Should I continue with part two?')).toBe(true)
    expect(replyAsksPerson('Let me know if you want the longer version.')).toBe(true)
    expect(replyAsksPerson('I wrote `a.md`. Everything is in place.')).toBe(false)
  })
})
