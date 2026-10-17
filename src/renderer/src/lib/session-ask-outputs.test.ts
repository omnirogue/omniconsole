import { describe, expect, it } from 'vitest'
import type { SessionAsk } from '../../../shared/session-asks'
import type { FilesAndLinksCard } from './session-files-and-links'
import { sessionAskOutputs } from './session-ask-outputs'

function ask(index: number): SessionAsk {
  return {
    index,
    at: index,
    title: `Ask ${index}`,
    full: `Ask ${index}`,
    replies: 0,
    answered: true
  }
}

function file(path: string, kind: 'image' | 'video' | 'audio' | 'html', messageIndex: number) {
  return {
    type: 'file',
    key: `file:${path}`,
    path,
    kind,
    name: path,
    location: '',
    messageIndex
  } satisfies FilesAndLinksCard
}

describe('sessionAskOutputs', () => {
  it('credits each output to the ask that was open when it appeared', () => {
    const cards: FilesAndLinksCard[] = [
      {
        type: 'pull-request',
        key: 'pr:a/b#12',
        number: 12,
        url: 'u',
        location: 'a/b',
        messageIndex: 3
      },
      {
        type: 'pull-request',
        key: 'pr:a/b#7',
        number: 7,
        url: 'u',
        location: 'a/b',
        messageIndex: 2
      },
      file('/out/a.png', 'image', 6),
      file('/out/b.png', 'image', 7),
      file('/out/c.mp4', 'video', 7),
      file('/out/v.mp3', 'audio', 8),
      file('/out/page.html', 'html', 1),
      {
        type: 'link',
        key: 'link:drive',
        kind: 'service',
        url: 'https://drive.google.com/x',
        name: 'Google Drive',
        location: 'drive.google.com',
        messageIndex: 9
      },
      { type: 'pull-request', key: 'pr:a/b#1', number: 1, url: 'u', location: 'a/b' }
    ]
    expect(sessionAskOutputs([ask(1), ask(5)], cards)).toEqual([
      { pullRequests: [7, 12], images: 0, videos: 0, audio: 0, documents: 1, links: 0 },
      { pullRequests: [], images: 2, videos: 1, audio: 1, documents: 0, links: 1 }
    ])
  })
})
