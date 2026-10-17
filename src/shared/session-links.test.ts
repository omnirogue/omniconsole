import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import {
  classifySessionLink,
  extractSessionLinks,
  isMachineOrTemplateUrl,
  isOwnedSiteRoot,
  isPreviewHost,
  normalizeLinkKey,
  previewPullRequestNumber,
  sessionLinksInText,
  trimMatchedUrl
} from './session-links'

function assistant(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text }]
  }
}

function toolResult(id: string, output: string): NativeChatMessage {
  return {
    id,
    role: 'tool',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'tool-result', output }]
  }
}

describe('trimMatchedUrl', () => {
  it.each([
    ['https://x.vercel.app/page.', 'https://x.vercel.app/page'],
    ['https://x.vercel.app/page),', 'https://x.vercel.app/page'],
    ['https://x.vercel.app/page**', 'https://x.vercel.app/page'],
    ['http://localhost:3000/!?', 'http://localhost:3000/'],
    ['https://en.example.com/wiki/Foo_(bar)', 'https://en.example.com/wiki/Foo_(bar)'],
    ['https://x.vercel.app/a]', 'https://x.vercel.app/a']
  ])('%s → %s', (raw, trimmed) => {
    expect(trimMatchedUrl(raw)).toBe(trimmed)
  })
})

describe('classifySessionLink', () => {
  it('detects claude.ai artifacts on both path shapes', () => {
    expect(classifySessionLink('https://claude.ai/code/artifact/abc-123')?.kind).toBe('artifact')
    expect(classifySessionLink('https://claude.ai/artifact/abc-123')?.kind).toBe('artifact')
    expect(classifySessionLink('https://claude.ai/chat/abc-123')).toBeNull()
    expect(classifySessionLink('https://evil.example/claude.ai/artifact/abc')).toBeNull()
  })

  it('takes loopback URLs only with a port', () => {
    expect(classifySessionLink('http://localhost:5173/')?.kind).toBe('localhost')
    expect(classifySessionLink('http://127.0.0.1:8080/app')?.kind).toBe('localhost')
    expect(classifySessionLink('http://localhost/')).toBeNull()
  })

  it('keeps only allowlisted preview hosts', () => {
    expect(classifySessionLink('https://my-app-git-x.vercel.app/')?.kind).toBe('preview')
    expect(classifySessionLink('https://deploy.netlify.app/')?.kind).toBe('preview')
    expect(classifySessionLink('https://staging.omnirogue.com/offer')?.kind).toBe('preview')
    expect(classifySessionLink('https://omnirogue.com/')?.kind).toBe('preview')
    expect(classifySessionLink('https://vercel.app/')).toBeNull()
    expect(classifySessionLink('https://notvercel.app/')).toBeNull()
    expect(classifySessionLink('https://omnirogue.com.evil.io/')).toBeNull()
    expect(classifySessionLink('https://docs.python.org/3/')).toBeNull()
    expect(isPreviewHost('user.github.io')).toBe(true)
    expect(isPreviewHost('github.io')).toBe(false)
  })

  it('canonicalises GitHub pull request URLs', () => {
    expect(classifySessionLink('https://github.com/omnirogue/omni-ide/pull/531/files')).toEqual({
      kind: 'pull-request',
      url: 'https://github.com/omnirogue/omni-ide/pull/531',
      pullRequest: { owner: 'omnirogue', repo: 'omni-ide', number: 531 }
    })
    expect(classifySessionLink('https://github.com/omnirogue/omni-ide/issues/5')).toBeNull()
  })

  it('refuses URLs that carry credentials', () => {
    expect(classifySessionLink('https://user:secret@app.vercel.app/')).toBeNull()
  })
})

describe('extractSessionLinks', () => {
  it('finds links in assistant prose and tool output, never in the person’s own turns', () => {
    const messages: NativeChatMessage[] = [
      { ...assistant('u', 'see https://app.vercel.app/'), role: 'user' },
      assistant(
        'a',
        'Preview: https://one.vercel.app/, and the dev server at http://localhost:3000.'
      ),
      toolResult('t', 'Local:   http://127.0.0.1:4173/\nhttps://claude.ai/code/artifact/xyz')
    ]
    expect(extractSessionLinks(messages).map((link) => link.url)).toEqual([
      'https://claude.ai/code/artifact/xyz',
      'http://127.0.0.1:4173/',
      'http://localhost:3000',
      'https://one.vercel.app/'
    ])
  })

  it('dedupes by normalized URL and moves a repeated link to its newest mention', () => {
    const messages = [
      assistant('1', 'https://one.vercel.app/ and https://two.vercel.app'),
      assistant('2', 'Again: https://ONE.vercel.app (updated)')
    ]
    const links = extractSessionLinks(messages)
    expect(links.map((link) => [link.key, link.messageIndex])).toEqual([
      [normalizeLinkKey('https://one.vercel.app'), 1],
      [normalizeLinkKey('https://two.vercel.app'), 0]
    ])
  })

  it('ignores ordinary links and text without any URL', () => {
    expect(sessionLinksInText('Read https://example.com/docs and https://google.com.')).toEqual([])
    expect(sessionLinksInText('no links here')).toEqual([])
  })

  it('returns the same result for an unchanged message on a later pass', () => {
    const message = assistant('1', 'http://localhost:8000/')
    const first = extractSessionLinks([message])
    expect(extractSessionLinks([message])).toEqual(first)
  })
})

describe('links no person opens', () => {
  it.each([
    'https://api-pr-{number}.betacorp.com',
    'https://pr-%7Bnumber%7D.betacorp.com/',
    'https://api.omnirogue.com/v1/agents',
    'https://api.dev.omnirogue.com',
    'https://api-pr-535.preview.omnirogue.com?other=1',
    'http://127.0.0.1:3000/health',
    'https://staging.omnirogue.com/api/fair-use/policy',
    'http://127.0.0.1:1'
  ])('drops %s', (url) => {
    expect(isMachineOrTemplateUrl(url)).toBe(true)
    expect(classifySessionLink(url)).toBeNull()
  })

  it('keeps pages, previews and dev servers', () => {
    for (const url of [
      'https://pr-1003.preview.omnirogue.com/create/video',
      'http://localhost:5173/',
      'https://omnirogue.com/'
    ]) {
      expect(isMachineOrTemplateUrl(url)).toBe(false)
    }
  })
})

describe('previewPullRequestNumber', () => {
  it('reads the PR a preview host was deployed for', () => {
    expect(previewPullRequestNumber('https://pr-1003.preview.omnirogue.com/create/video')).toBe(
      1003
    )
    expect(previewPullRequestNumber('https://site-pr-12.vercel.app/')).toBe(12)
    expect(previewPullRequestNumber('https://deploy-preview-42--site.netlify.app/')).toBe(42)
    expect(previewPullRequestNumber('https://staging.omnirogue.com/')).toBeNull()
  })
})

describe('isOwnedSiteRoot', () => {
  it('marks a brand home page, not its other pages or previews', () => {
    expect(isOwnedSiteRoot('https://omnirogue.com')).toBe(true)
    expect(isOwnedSiteRoot('https://www.betacorp.com/')).toBe(true)
    expect(isOwnedSiteRoot('https://omnirogue.com/plans')).toBe(false)
    expect(isOwnedSiteRoot('https://pr-1.preview.omnirogue.com/')).toBe(false)
  })
})

describe('work-service links', () => {
  it('keeps links to where finished work lives, named by service', () => {
    expect(classifySessionLink('https://drive.google.com/drive/folders/abc')).toMatchObject({
      kind: 'service',
      service: 'Google Drive'
    })
    expect(classifySessionLink('https://omnirogue.notion.site/Webinar-v3')).toMatchObject({
      kind: 'service',
      service: 'Notion'
    })
    expect(classifySessionLink('https://youtu.be/xyz')).toMatchObject({ service: 'YouTube' })
    expect(classifySessionLink('https://www.figma.com/file/abc')).toMatchObject({
      service: 'Figma'
    })
    expect(classifySessionLink('https://google.com/search?q=x')).toBeNull()
  })
})
