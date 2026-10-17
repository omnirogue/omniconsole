// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { MetaIcon } from '@/lib/agent-icon-glyphs'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import { SessionRowModelIcon } from './SessionRowModelIcon'

const initialState = useAppStore.getInitialState()
const PANE = 'tab-1:pane-1'

function status(model: string): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: PANE,
    stateHistory: [],
    model
  }
}

function rowMark(agent: string): HTMLElement | null {
  const { container } = render(<SessionRowModelIcon session={{ agent, paneKey: PANE }} />)
  return container.querySelector('[data-session-row-model]')
}

describe('SessionRowModelIcon', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('marks a Muse Code session with the Meta logo, as Claude and Codex rows get theirs', () => {
    expect(rowMark('claude')?.dataset.sessionRowModel).toBe('anthropic')
    expect(rowMark('codex')?.dataset.sessionRowModel).toBe('openai')

    const muse = rowMark('muse')
    expect(muse?.dataset.sessionRowModel).toBe('meta')
    expect(muse?.getAttribute('aria-label')).toBe('Meta')
    const { container } = render(<MetaIcon size={11} />)
    expect(muse?.innerHTML).toBe(container.innerHTML)
  })

  it('names the live Muse model in the tooltip', () => {
    useAppStore.setState({ agentStatusByPaneKey: { [PANE]: status('muse-wonder-1.0') } })

    const muse = rowMark('muse')
    expect(muse?.dataset.sessionRowModel).toBe('meta')
    expect(muse?.getAttribute('title')).toBe('Meta · muse-wonder-1.0')
  })
})
