// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import type { AskAnswerSelection, AskPrompt } from './native-chat-interactive-prompt'

// The card resolves its own label-keyed selection state into the index-based
// answer the delivery layer needs. These tests pin that resolution — the exact
// seam of STA-1860 (a non-first pick must surface as its option INDEX, not the
// first option / the raw label).

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(
  prompt: AskPrompt,
  onAnswer: (s: AskAnswerSelection[]) => void,
  allowOther = true
): void {
  act(() => {
    root.render(
      <NativeChatQuestionCard
        prompt={prompt}
        onAnswer={onAnswer}
        onCancel={() => {}}
        allowOther={allowOther}
      />
    )
  })
}

function click(button: Element | undefined, describe: string): void {
  if (!button) {
    throw new Error(`button not found: ${describe}`)
  }
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

// Option rows carry a badge number + label, so match them by the label they
// contain among the aria-pressed selectable rows.
function clickOption(label: string): void {
  const row = [...container.querySelectorAll('button[aria-pressed]')].find((b) =>
    b.textContent?.includes(label)
  )
  click(row, `option ${label}`)
}

function clickOptionAt(index: number): void {
  click(container.querySelectorAll('button[aria-pressed]')[index], `option index ${index}`)
}

function clickAction(text: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text
  )
  click(button, text)
}

const tabsOrSpaces: AskPrompt = {
  questions: [
    {
      question: 'Do you prefer tabs or spaces?',
      header: 'Indent',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }]
    }
  ]
}

describe('NativeChatQuestionCard', () => {
  it('delivers the SECOND option with one click, without submitting a default on render', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)

    expect(onAnswer).not.toHaveBeenCalled()
    clickOption('Spaces')

    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [1], other: '' }])
  })

  it('delivers a multi-select pick as its option indices', () => {
    const onAnswer = vi.fn()
    render(
      {
        questions: [
          {
            question: 'Which fruits?',
            multiSelect: true,
            options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }]
          }
        ]
      },
      onAnswer
    )

    clickOption('Cherry')
    clickOption('Apple')
    expect(onAnswer).not.toHaveBeenCalled()
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [0, 2], other: '' }])
  })

  it('keeps duplicate labels distinct by their numbered row', () => {
    const onAnswer = vi.fn()
    render(
      {
        questions: [
          {
            question: 'Which duplicate row?',
            multiSelect: false,
            options: [{ label: 'Same' }, { label: 'Same' }]
          }
        ]
      },
      onAnswer
    )

    clickOptionAt(1)

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [1], other: '' }])
  })

  it('requires each question to be explicitly answered before a choice click submits the bundle', () => {
    const onAnswer = vi.fn()
    render(
      {
        questions: [
          ...tabsOrSpaces.questions,
          {
            question: 'Which color?',
            header: 'Color',
            multiSelect: false,
            options: [{ label: 'Red' }, { label: 'Green' }]
          }
        ]
      },
      onAnswer
    )
    clickAction('Color')
    clickOption('Green')
    expect(onAnswer).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Do you prefer tabs or spaces?')
    clickOption('Spaces')
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([
      { indices: [1], other: '' },
      { indices: [1], other: '' }
    ])
  })

  it('does not submit an unconfirmed multi-select answer after jumping to a later question', () => {
    const onAnswer = vi.fn()
    render(
      {
        questions: [
          {
            question: 'Which fruits?',
            header: 'Fruit',
            multiSelect: true,
            options: [{ label: 'Apple' }, { label: 'Banana' }]
          },
          ...tabsOrSpaces.questions
        ]
      },
      onAnswer
    )
    clickOption('Banana')
    clickAction('Indent')
    clickOption('Spaces')
    expect(onAnswer).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Which fruits?')
    clickAction('Next')
    clickOption('Spaces')
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([
      { indices: [1], other: '' },
      { indices: [1], other: '' }
    ])
  })

  it('carries free text through as the other answer', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)

    const input = container.querySelector('input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'four spaces')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onAnswer).not.toHaveBeenCalled()
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: 'four spaces' }])
  })

  it('hides free text when the provider requires a listed option', () => {
    render(tabsOrSpaces, vi.fn(), false)

    expect(container.querySelector('input')).toBeNull()
    expect(container.textContent).not.toContain('Type your answer')
  })
  it('holds a partial answer back when every question must be answered', () => {
    const onAnswer = vi.fn()
    const prompt: AskPrompt = {
      questions: [
        {
          question: 'Ocean?',
          multiSelect: false,
          options: [{ label: 'Atlantic' }, { label: 'Pacific' }]
        },
        { question: 'Colors?', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue' }] }
      ]
    }
    act(() => {
      root.render(
        <NativeChatQuestionCard
          prompt={prompt}
          onAnswer={onAnswer}
          onCancel={() => {}}
          allowOther={false}
          requireEveryAnswer
        />
      )
    })
    clickAction('Skip')
    clickOption('Blue')
    clickAction('Submit')

    expect(onAnswer).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Ocean?')
    clickOption('Pacific')
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([
      { indices: [1], other: '' },
      { indices: [1], other: '' }
    ])
  })

  it('shows a terminal-only question without a way to submit it', () => {
    const onAnswer = vi.fn()
    act(() => {
      root.render(
        <NativeChatQuestionCard
          prompt={tabsOrSpaces}
          onAnswer={onAnswer}
          onCancel={() => {}}
          allowOther={false}
          answerInTerminal
        />
      )
    })
    clickOptionAt(1)

    expect(onAnswer).not.toHaveBeenCalled()
    expect(container.querySelector('[data-question-answer-in-terminal]')).not.toBeNull()
    expect(
      [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())
    ).not.toContain('Skip')
  })
})
