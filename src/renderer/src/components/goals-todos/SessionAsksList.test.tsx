// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionAskOutputs } from '@/lib/session-ask-outputs'
import type { SessionAsk } from '../../../../shared/session-asks'
import { askOutputsLabel, SessionAsksList } from './SessionAsksList'

afterEach(cleanup)

function ask(index: number, title: string, answered = true): SessionAsk {
  return { index, at: index, title, full: `${title} (full)`, replies: 0, answered }
}

const none: SessionAskOutputs = {
  pullRequests: [],
  images: 0,
  videos: 0,
  audio: 0,
  documents: 0,
  links: 0
}

function states(): (string | null)[] {
  return [...document.querySelectorAll('[data-session-ask]')].map((row) =>
    row.getAttribute('data-session-ask')
  )
}

describe('SessionAsksList', () => {
  it('marks answered asks with an outline check and the latest as in progress while working', () => {
    render(
      <SessionAsksList
        asks={[ask(1, 'Draft the webinar script'), ask(4, 'Record the voiceover', false)]}
        outputs={[
          { ...none, documents: 1 },
          { ...none, audio: 1 }
        ]}
        paneState="working"
      />
    )
    expect(states()).toEqual(['answered', 'now'])
    expect(document.querySelector('[data-session-ask-mark="answered"]')).toBeTruthy()
    expect(screen.getByText('Draft the webinar script').getAttribute('title')).toBe(
      'Draft the webinar script (full)'
    )
    expect(screen.getByText('1 audio file')).toBeTruthy()
  })

  it('says the latest ask waits on the person when the AI asked something back', () => {
    render(
      <SessionAsksList asks={[ask(1, 'Pick the hooks')]} outputs={[none]} paneState="waiting" />
    )
    expect(states()).toEqual(['you'])
  })

  it('shows the latest three and folds the rest behind one button', () => {
    const asks = [1, 2, 3, 4, 5].map((index) => ask(index, `Ask ${index}`))
    render(<SessionAsksList asks={asks} outputs={asks.map(() => none)} paneState="done" />)
    expect(document.querySelectorAll('[data-session-ask]')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '2 earlier asks' }))
    expect(document.querySelectorAll('[data-session-ask]')).toHaveLength(5)
  })
})

describe('askOutputsLabel', () => {
  it('names what an ask produced in a few words', () => {
    expect(
      askOutputsLabel({
        pullRequests: [1002, 1003],
        images: 3,
        videos: 1,
        audio: 0,
        documents: 0,
        links: 2
      })
    ).toBe('PR #1002, #1003 · 3 images · 1 video · 2 links')
    expect(askOutputsLabel(none)).toBe('')
  })
})
