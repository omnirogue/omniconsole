// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { mocks } from './NativeChatStructuredSession.test-support'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'

afterEach(cleanup)

it('keeps history and hides the composer while a viewer is paused', () => {
  mocks.viewerState = 'exited'
  mocks.fallback = false
  render(
    <NativeChatStructuredSession
      worktreeId="wt-1"
      tabId="tab-1"
      sessionId="session-1"
      target={{ kind: 'local' }}
      agent="codex"
      isVisible
      viewer
    />
  )
  expect(screen.getByTestId('message-list')).toBeTruthy()
  expect(screen.getByText('Paused. Resume to continue this conversation.')).toBeTruthy()
  expect(screen.queryByTestId('structured-composer')).toBeNull()
})

it('labels an older host while preserving its chat composer', () => {
  mocks.viewerState = 'unverifiable'
  mocks.fallback = true
  render(
    <NativeChatStructuredSession
      worktreeId="wt-1"
      tabId="tab-1"
      sessionId="session-1"
      target={{ kind: 'environment', environmentId: 'older' }}
      agent="codex"
      isVisible
      viewer
    />
  )
  expect(screen.getByText(/legacy viewing/)).toBeTruthy()
  expect(screen.getByTestId('structured-composer')).toBeTruthy()
})
