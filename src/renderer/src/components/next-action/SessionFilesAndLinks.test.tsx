// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { SessionFilesAndLinks } from './SessionFilesAndLinks'

const fixture = vi.hoisted(() => ({
  existing: new Map<string, boolean>(),
  liveness: new Map<string, 'live' | 'stopped'>(),
  review: null as unknown,
  thumbnails: new Map<string, string>()
}))
const target = { worktreeId: 'wt', worktreePath: '/repo', runtimeEnvironmentId: null }

vi.mock('./use-session-files-and-links', () => ({
  useSessionFileTarget: () => target,
  useWorkspaceReview: () => fixture.review,
  useExistingSessionFiles: () => fixture.existing,
  useLoopbackLiveness: () => fixture.liveness,
  useSessionFileThumbnail: (path: string) => fixture.thumbnails.get(path) ?? null
}))

const actions = vi.hoisted(() => ({
  openUrlInApp: vi.fn(),
  openUrlInSystemBrowser: vi.fn(),
  copyLink: vi.fn(() => Promise.resolve()),
  openFile: vi.fn(),
  playVideo: vi.fn(),
  openFileInSystemApp: vi.fn(),
  reveal: vi.fn()
}))
vi.mock('@/lib/session-files-and-links-actions', () => ({
  sessionFilesAndLinksActions: actions,
  canOpenSessionFileLocally: () => true,
  canOpenSessionUrlExternally: () => true
}))

function write(id: string, path: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'tool-call', name: 'Write', input: { file_path: path } }]
  }
}

function say(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text }]
  }
}

function mount(messages: NativeChatMessage[]): void {
  render(
    <TooltipProvider>
      <SessionFilesAndLinks hostId="local" worktreeId="wt" messages={messages} active />
    </TooltipProvider>
  )
}

function card(kind: string): HTMLElement {
  return document.querySelector(`[data-files-links-card="${kind}"]`) as HTMLElement
}

function primary(kind: string): void {
  fireEvent.click(card(kind).querySelector('[data-files-links-primary]')!)
}

function secondary(kind: string): void {
  fireEvent.click(card(kind).querySelector('[data-files-links-secondary]')!)
}

function unfold(): void {
  fireEvent.click(document.querySelector('[data-files-links-fold]')!)
}

function result(): HTMLElement | null {
  return document.querySelector('[data-files-links-result]')
}

beforeEach(() => {
  fixture.existing = new Map()
  fixture.liveness = new Map()
  fixture.review = null
  fixture.thumbnails = new Map()
  for (const fn of Object.values(actions)) {
    fn.mockClear()
  }
})
afterEach(cleanup)

describe('Files & links', () => {
  it('says so in one muted line when there is nothing to show', () => {
    mount([say('1', 'Nothing produced yet.')])
    expect(screen.getByText('No files or links yet')).toBeTruthy()
    expect(document.querySelector('[data-files-links-card]')).toBeNull()
  })

  it('hides written files that no longer exist or are not yet checked', () => {
    fixture.existing = new Map([
      ['/repo/kept.png', true],
      ['/repo/deleted.png', false]
    ])
    mount([write('1', '/repo/kept.png'), write('2', '/repo/deleted.png'), write('3', 'fresh.md')])
    expect(screen.getByText('kept.png')).toBeTruthy()
    expect(screen.queryByText('deleted.png')).toBeNull()
    expect(screen.queryByText('fresh.md')).toBeNull()
  })

  it('renders each file type with its thumbnail or icon and routes both buttons', () => {
    const paths = [
      '/repo/img/a.png',
      '/repo/video/b.mp4',
      '/repo/site/c.html',
      '/repo/docs/d.pdf',
      '/repo/src/e.ts'
    ]
    fixture.existing = new Map(paths.map((path) => [path, true]))
    fixture.thumbnails = new Map([['/repo/img/a.png', 'blob:thumb']])
    mount(paths.map((path, index) => write(String(index), path)))
    // The newest file a person looks at (not source) is the Result; the rest fold behind it.
    expect(result()!.getAttribute('data-files-links-card')).toBe('pdf')
    expect(document.querySelectorAll('[data-files-links-card]')).toHaveLength(1)
    unfold()

    expect(card('image').querySelector('img')!.getAttribute('src')).toBe('blob:thumb')
    expect(card('video').querySelector('img')).toBeNull()

    primary('image')
    expect(actions.openFile).toHaveBeenLastCalledWith('/repo/img/a.png', target)
    secondary('image')
    expect(actions.reveal).toHaveBeenLastCalledWith('/repo/img/a.png', target)

    primary('video')
    expect(actions.playVideo).toHaveBeenCalledWith('/repo/video/b.mp4', target)

    primary('html')
    expect(actions.openFile).toHaveBeenLastCalledWith('/repo/site/c.html', target)
    secondary('html')
    expect(actions.openFileInSystemApp).toHaveBeenCalledWith('/repo/site/c.html', target)

    primary('pdf')
    expect(actions.openFile).toHaveBeenLastCalledWith('/repo/docs/d.pdf', target)

    expect(within(card('other')).getByRole('button', { name: 'Edit' })).toBeTruthy()
    primary('other')
    expect(actions.openFile).toHaveBeenLastCalledWith('/repo/src/e.ts', target)
  })

  it('opens artifacts in the system browser and copies their link', () => {
    mount([say('1', 'Artifact: https://claude.ai/code/artifact/abc123.')])
    expect(within(card('artifact')).getByText('Claude artifact')).toBeTruthy()
    primary('artifact')
    expect(actions.openUrlInSystemBrowser).toHaveBeenCalledWith(
      'https://claude.ai/code/artifact/abc123',
      'local'
    )
    expect(actions.openUrlInApp).not.toHaveBeenCalled()
    secondary('artifact')
    expect(actions.copyLink).toHaveBeenCalledWith('https://claude.ai/code/artifact/abc123')
  })

  it('opens local servers and previews in the app, with the system browser one click away', () => {
    fixture.liveness = new Map([['http://localhost:5173/', 'live']])
    mount([say('1', 'Dev: http://localhost:5173/ Preview: https://site-git-x.vercel.app/')])
    expect(result()!.getAttribute('data-files-links-card')).toBe('localhost')
    expect(card('localhost').querySelector('[data-files-links-liveness="live"]')).toBeTruthy()
    primary('localhost')
    expect(actions.openUrlInApp).toHaveBeenCalledWith('http://localhost:5173/', 'wt', 'local')
    unfold()
    primary('preview')
    expect(actions.openUrlInApp).toHaveBeenLastCalledWith(
      'https://site-git-x.vercel.app/',
      'wt',
      'local'
    )
    secondary('preview')
    expect(actions.openUrlInSystemBrowser).toHaveBeenCalledWith(
      'https://site-git-x.vercel.app/',
      'local'
    )
  })

  it('leads with the workspace PR, its state and checks, merging the transcript link', () => {
    fixture.review = {
      number: 12,
      url: 'https://github.com/acme/site/pull/12',
      state: 'merged',
      status: 'failure'
    }
    mount([say('1', 'Opened https://github.com/acme/site/pull/12 for review.')])
    const cards = document.querySelectorAll('[data-files-links-card]')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.getAttribute('data-files-links-card')).toBe('pull-request')
    expect(cards[0]!.textContent).toContain('PR #12 · merged · checks failing')
    primary('pull-request')
    expect(actions.openUrlInApp).toHaveBeenCalledWith(
      'https://github.com/acme/site/pull/12',
      'wt',
      'local'
    )
    secondary('pull-request')
    expect(actions.openUrlInSystemBrowser).toHaveBeenCalledWith(
      'https://github.com/acme/site/pull/12',
      'local'
    )
  })

  it('folds source files behind one line, shows eight, then all of them on request', () => {
    const paths = Array.from({ length: 11 }, (_, index) => `/repo/file-${index}.txt`)
    fixture.existing = new Map(paths.map((path) => [path, true]))
    mount(paths.map((path, index) => write(String(index), path)))
    // Source files are not a Result, so nothing is set apart and the fold says what it holds.
    expect(result()).toBeNull()
    expect(document.querySelector('[data-files-links-fold]')!.textContent).toBe('11 files')
    expect(document.querySelectorAll('[data-files-links-card]')).toHaveLength(0)
    unfold()
    expect(document.querySelectorAll('[data-files-links-card]')).toHaveLength(8)
    // Newest first.
    expect(document.querySelector('[data-files-links-card]')!.textContent).toContain('file-10.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Show all 11' }))
    expect(document.querySelectorAll('[data-files-links-card]')).toHaveLength(11)
  })
  it('makes the preview of the session’s own PR the Result and folds the rest (22 Sep session)', () => {
    mount([
      say(
        '1',
        [
          'https://github.com/omnirogue/omnirogue/pull/1002',
          'https://github.com/omnirogue/omnirogue/pull/1003',
          'https://github.com/omnirogue/omnirogue/pull/1007',
          'https://github.com/omnirogue/omnirogue/pull/1008',
          'Template: https://api-pr-{number}.betacorp.com and https://pr-{number}.betacorp.com',
          'Hosts: https://betacorp.com https://omnirogue.com https://api.omnirogue.com',
          'https://api.dev.omnirogue.com http://127.0.0.1:1 http://127.0.0.1:3000/health',
          'https://api-pr-535.preview.omnirogue.com https://api-pr-535.preview.omnirogue.com?other=1',
          'https://pr-535.preview.omnirogue.com',
          'https://pr-1002.preview.omnirogue.com/create/image',
          'https://pr-1002.preview.omnirogue.com/create/video'
        ].join('\n')
      ),
      say('2', 'Checked https://pr-1003.preview.omnirogue.com/create/video')
    ])
    const shown = result()!
    expect(shown.getAttribute('data-files-links-card')).toBe('preview')
    expect(shown.textContent).toContain('PR #1003 preview')
    expect(shown.textContent).toContain('/create/video')
    const fold = document.querySelector('[data-files-links-fold]')!
    expect(fold.textContent).toBe('More: 4 PRs · 2 previews · 2 other')
    unfold()
    const text = document.querySelector('[data-files-links-rest]')!.textContent
    expect(text).toContain('PR #1002 preview')
    expect(text).toContain('2 pages')
    for (const noise of ['{number}', 'api.', 'api-pr', '127.0.0.1', 'health']) {
      expect(document.body.textContent).not.toContain(noise)
    }
  })

  it('offers several deliverables in one folder as that folder', () => {
    const paths = ['/out/ads/one.png', '/out/ads/two.png', '/out/ads/three.png', '/repo/a.ts']
    fixture.existing = new Map(paths.map((path) => [path, true]))
    mount(paths.map((path, index) => write(String(index), path)))
    const shown = result()!
    expect(shown.getAttribute('data-files-links-card')).toBe('folder')
    expect(shown.textContent).toContain('ads')
    expect(shown.textContent).toContain('3 files')
    fireEvent.click(within(shown).getByRole('button', { name: 'Show folder' }))
    expect(actions.reveal).toHaveBeenCalledWith('/out/ads/three.png', target)
    expect(document.querySelector('[data-files-links-fold]')!.textContent).toBe('More: 1 file')
  })

  it('drops a local server that is not running', () => {
    fixture.liveness = new Map([['http://localhost:4000/', 'stopped']])
    mount([say('1', 'Dev: http://localhost:4000/')])
    expect(document.querySelector('[data-files-links-card]')).toBeNull()
    expect(document.querySelector('[data-files-links-empty]')).toBeTruthy()
  })
})
