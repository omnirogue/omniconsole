import { describe, expect, it } from 'vitest'
import {
  buildFinalSummaryMarkdown,
  finalSummaryFileName,
  outputFileName,
  parseDeliverablesManifest,
  resolveWorkspaceOutputPath
} from './session-follow-up-deliverables'

describe('follow-up deliverables', () => {
  it('resolves typed paths inside the workspace and refuses everything else', () => {
    expect(resolveWorkspaceOutputPath('/Users/me/Webinar', 'out/report.md')).toBe(
      '/Users/me/Webinar/out/report.md'
    )
    expect(resolveWorkspaceOutputPath('/Users/me/Webinar/', './deck.pptx')).toBe(
      '/Users/me/Webinar/deck.pptx'
    )
    expect(resolveWorkspaceOutputPath('/Users/me/Webinar', '"/Users/me/Webinar/a.md"')).toBe(
      '/Users/me/Webinar/a.md'
    )
    expect(resolveWorkspaceOutputPath('/Users/me/Webinar', '/Users/me/other/a.md')).toBeNull()
    expect(resolveWorkspaceOutputPath('/Users/me/Webinar', '/Users/me/Webinar2/a.md')).toBeNull()
    expect(resolveWorkspaceOutputPath('/Users/me/Webinar', '../secrets.txt')).toBeNull()
    expect(resolveWorkspaceOutputPath('/Users/me/Webinar', '   ')).toBeNull()
    expect(resolveWorkspaceOutputPath('C:\\Work\\Webinar', 'out\\report.md')).toBe(
      'C:\\Work\\Webinar\\out\\report.md'
    )
    expect(resolveWorkspaceOutputPath('C:\\Work\\Webinar', 'c:\\work\\webinar\\x.md')).toBe(
      'c:\\work\\webinar\\x.md'
    )
    expect(outputFileName('C:\\Work\\Webinar\\out\\report.md')).toBe('report.md')
  })

  it('reads the files a manifest declares beside it, refusing entries outside the workspace', () => {
    const base = '/Users/me/Webinar/.omni/runs/chn_1/step_1'
    const manifest = [
      '# Manifest',
      '',
      '- `report.md` — the written report',
      '- slides/deck.pptx: the deck',
      '| File | Purpose |',
      '| --- | --- |',
      '| data.csv | numbers |',
      '1. [Summary](summary.pdf)',
      `- ${base}/absolute.txt`,
      '- /Users/me/other/leak.txt',
      '- ../escape.md',
      '- manifest.md',
      'Some prose that names nothing.'
    ].join('\n')
    expect(parseDeliverablesManifest(manifest, `${base}/manifest.md`, '/Users/me/Webinar')).toEqual(
      {
        paths: [
          `${base}/report.md`,
          `${base}/slides/deck.pptx`,
          `${base}/data.csv`,
          `${base}/summary.pdf`,
          `${base}/absolute.txt`
        ],
        refused: ['/Users/me/other/leak.txt', '../escape.md'],
        // The same relative entries read from the workspace root; an absolute one has no second reading.
        inWorkspace: {
          [`${base}/report.md`]: '/Users/me/Webinar/report.md',
          [`${base}/slides/deck.pptx`]: '/Users/me/Webinar/slides/deck.pptx',
          [`${base}/data.csv`]: '/Users/me/Webinar/data.csv',
          [`${base}/summary.pdf`]: '/Users/me/Webinar/summary.pdf'
        }
      }
    )
  })

  it('builds a named Markdown summary that keeps the output fenced as written', () => {
    expect(finalSummaryFileName('Draft Webinar Intro!')).toBe(
      'draft-webinar-intro-final-summary.md'
    )
    expect(finalSummaryFileName('***')).toBe('session-final-summary.md')
    const markdown = buildFinalSummaryMarkdown({
      title: 'Webinar',
      sessionLabel: 'Draft',
      finishedAt: '2026-09-11T10:00:00.000Z',
      workspacePath: '/w',
      output: 'done\n```js\nx\n```'
    })
    expect(markdown).toContain('# Webinar')
    expect(markdown).toContain('- Session: Draft')
    expect(markdown).toContain('````text\ndone\n```js\nx\n```\n````\n')
  })
})
