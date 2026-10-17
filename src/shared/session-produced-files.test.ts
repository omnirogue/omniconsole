import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import {
  commandOutputPaths,
  commandText,
  conversationProducedFileEntries,
  reportedOutputPaths
} from './session-produced-files'

describe('commandOutputPaths', () => {
  it.each([
    ['cd /tmp && ffmpeg -y -i in.mp4 -vf scale=1080:1920 /out/ad-1.mp4', ['/out/ad-1.mp4']],
    ['curl -sL https://x.test/a.png -o /out/a.png && echo done > log.txt', ['/out/a.png']],
    [
      'python3 render.py --output=/out/deck.pptx > /out/report.pdf 2>&1',
      ['/out/deck.pptx', '/out/report.pdf']
    ],
    ['cp /tmp/a.mp3 /out/voice.mp3', ['/out/voice.mp3']],
    ['grep -r foo src > /dev/null', []],
    ['curl -sL https://cdn.test/hero.png -o /out/hero.png', ['/out/hero.png']],
    ['wget https://cdn.test/clip.mp4', []],
    ['pnpm test', []]
  ])('%s', (command, paths) => {
    expect(commandOutputPaths(command)).toEqual(paths)
  })
})

describe('reportedOutputPaths', () => {
  it('takes the files a tool says it wrote, for types a person opens', () => {
    expect(
      reportedOutputPaths(
        'Rendering\nSaved to /out/hero.png\nWrote: /out/cut.mov.\nwrote /out/app.log'
      )
    ).toEqual(['/out/hero.png', '/out/cut.mov'])
  })
})

describe('commandText', () => {
  it('reads Claude, Codex JSON and argv shapes', () => {
    expect(commandText({ command: 'ffmpeg -i a.mp4 b.mp4' })).toBe('ffmpeg -i a.mp4 b.mp4')
    expect(commandText('{"cmd":"ffmpeg -i a.mp4 b.mp4","workdir":"/x"}')).toBe(
      'ffmpeg -i a.mp4 b.mp4'
    )
    expect(commandText({ command: ['bash', '-lc', 'magick a.png /x/b.webp'] })).toBe(
      'magick a.png /x/b.webp'
    )
  })
})

describe('conversationProducedFileEntries', () => {
  it('collects command outputs and reported files, skipping failed results', () => {
    const messages: NativeChatMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        source: 'transcript',
        timestamp: 1,
        blocks: [
          { type: 'tool-call', name: 'Bash', input: { command: 'ffmpeg -i a.mov /out/final.mp4' } }
        ]
      },
      {
        id: 'b',
        role: 'tool',
        source: 'transcript',
        timestamp: 2,
        blocks: [
          { type: 'tool-result', output: 'Saved to /out/thumb.jpg' },
          { type: 'tool-result', output: 'Saved to /out/broken.png', isError: true }
        ]
      }
    ]
    expect(conversationProducedFileEntries(messages)).toEqual([
      { path: '/out/final.mp4', messageIndex: 0 },
      { path: '/out/thumb.jpg', messageIndex: 1 }
    ])
  })
})
