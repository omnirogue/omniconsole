// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsedNextStepSuggestionsFromText } from '../../../../shared/native-chat-next-action'

import { mocks, unknownRpc } from './NativeChatStructuredSession.test-support'

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

describe('NativeChatStructuredSession', () => {
  afterEach(() => {
    cleanup()
    mocks.call.mockReset()
    mocks.rpc.mockReset()
    mocks.rpc.mockImplementation(unknownRpc)
    mocks.mode = 'static'
    mocks.reply = '[file](file:///repo/src/main.ts)'
    mocks.isWorking = false
    mocks.supportsLiveInput = false
    mocks.messageListProps = null
    mocks.composerProps = null
    mocks.handlePasteEvent.mockReset()
    mocks.pasteFromClipboard.mockReset()
    mocks.submissions = []
    mocks.monitoringBackgroundTasks = false
    mocks.supportsBackgroundTaskStop = false
    mocks.supportsBackgroundTaskStopAll = true
    mocks.stopBackgroundTask.mockReset()
    mocks.backgroundTasks = []
  })

  it('renders the host’s steps for the real session and answers them through nextSteps.decide', async () => {
    mocks.reply = 'The durable solution is to fix bundled-skill refreshing.'
    // The host read these steps from the same reply at turn end.
    let parsed: Record<string, unknown> = {
      id: 'parsed-1',
      conversation: { worktreeId: 'workspace', kind: 'structured' },
      worktreeId: 'workspace',
      turnKey: 't1',
      origin: 'parsed',
      createdAt: 1,
      status: 'pending',
      suggestions: parsedNextStepSuggestionsFromText(mocks.reply).map((step, at) => ({
        ...step,
        id: `s${at + 1}`
      }))
    }
    mocks.rpc.mockImplementation((_target: unknown, method: string, params?: unknown) => {
      if (method === 'nextSteps.current') {
        return Promise.resolve({
          turnKey: 't1',
          parsed,
          answered: parsed.status === 'accepted',
          turnObserved: true,
          revision: parsed.status === 'accepted' ? 2 : 1
        })
      }
      if (method === 'nextSteps.decide') {
        parsed = { ...parsed, status: 'accepted' }
        return Promise.resolve({ set: parsed, queued: ['s1'], notQueued: [] })
      }
      // Keep going's state, and the stop every person's answer asks of the host first.
      if (method === 'nextSteps.list') {
        return Promise.resolve({
          sets: [],
          skips: [],
          revision: 1,
          keepGoing: [],
          keepGoingRevision: 1
        })
      }
      if (method === 'nextSteps.keepGoing') {
        return Promise.resolve({
          state: {
            conversation: (params as { conversation?: unknown } | undefined)?.conversation,
            enabled: false,
            maxRounds: 10,
            roundsUsed: 0,
            startedAt: 1
          }
        })
      }
      // Anything else, an offer included, is a call this surface must not make.
      return Promise.reject(new Error(`unexpected ${method}`))
    })
    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="recommendation-tab"
        sessionId="recommendation-session"
        target={{ kind: 'local' }}
        agent="codex"
        workRailInShell
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: /^Show prompt:/ }))
    // The prompt that would be sent carries the reply's own words.
    expect(screen.getByLabelText('Prompt that will be sent').textContent).toContain(
      'Please go ahead with this next step you suggested: The durable solution is to fix bundled-skill refreshing'
    )
    const read = mocks.rpc.mock.calls.find(([, method]) => method === 'nextSteps.current')!
    expect(read[2]).toMatchObject({
      conversation: {
        worktreeId: 'workspace',
        kind: 'structured',
        sessionId: 'recommendation-session'
      }
    })
    fireEvent.click(screen.getByRole('button', { name: /^Run:/ }))
    await waitFor(() =>
      expect(mocks.rpc.mock.calls.some(([, method]) => method === 'nextSteps.decide')).toBe(true)
    )
    expect(mocks.rpc.mock.calls.find(([, method]) => method === 'nextSteps.decide')![2]).toEqual({
      setId: 'parsed-1',
      decision: { action: 'run', suggestionIds: ['s1'] }
    })
    expect(mocks.rpc.mock.calls.some(([, method]) => method === 'nextSteps.offerParsed')).toBe(
      false
    )
    // The host queues it; the tray never types into the session itself.
    expect(mocks.call).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Run:/ })).toBeNull())
  })

  it('refuses active Codex input on an older host before adding it to the outbox', () => {
    mocks.isWorking = true
    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="tab"
        sessionId="session"
        target={{ kind: 'environment', environmentId: 'old-host' }}
        agent="codex"
      />
    )
    const send = mocks.composerProps?.structuredTransport?.send as (
      text: string,
      attachments: []
    ) => boolean
    expect(() => send('correction', [])).toThrow('session host needs an update')
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it.each(['claude', 'grok', 'omp'] as const)(
    'keeps active %s input out of an unsupported structured transport',
    (agent) => {
      mocks.isWorking = true
      render(
        <NativeChatStructuredSession
          worktreeId="workspace"
          isVisible
          tabId="tab"
          sessionId="session"
          target={{ kind: 'local' }}
          agent={agent}
        />
      )
      const transport = mocks.composerProps!.structuredTransport!
      expect(transport.sendUnavailableReason).toContain('cannot accept messages')
      const send = transport.send as (text: string, attachments: []) => boolean
      expect(() => send('correction', [])).toThrow('Your draft is kept')
      expect(mocks.call).not.toHaveBeenCalled()
    }
  )

  it('allows active input when the owning host advertises support', async () => {
    mocks.isWorking = true
    mocks.supportsLiveInput = true
    mocks.call.mockImplementation(() => new Promise(() => {}))
    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="tab"
        sessionId="session"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    const transport = mocks.composerProps!.structuredTransport!
    expect(transport.sendUnavailableReason).toBeUndefined()
    await act(async () => {
      const send = transport.send as (text: string, attachments: []) => boolean
      expect(send('correction', [])).toBe(true)
    })
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('keeps a second rapid send out of an older host while its first send is pending', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockImplementation(() => new Promise(() => {}))
    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="rapid-tab"
        sessionId="rapid-session"
        target={{ kind: 'environment', environmentId: 'old-host' }}
        agent="codex"
      />
    )
    await act(async () => {
      const send = mocks.composerProps?.structuredTransport?.send as (
        text: string,
        attachments: []
      ) => boolean
      expect(send('first', [])).toBe(true)
    })
    const send = mocks.composerProps?.structuredTransport?.send as (
      text: string,
      attachments: []
    ) => boolean
    expect(() => send('second', [])).toThrow('session host needs an update')
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('routes app-menu paste into the structured composer', () => {
    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="structured-tab-paste"
        sessionId="session-paste"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const composer = screen.getByTestId('structured-composer')
    composer.focus()
    window.dispatchEvent(new Event('omni-app-menu-paste', { cancelable: true }))

    expect(mocks.pasteFromClipboard).toHaveBeenCalledOnce()
  })

  it('wires remote structured file links through the host-aware native chat opener', () => {
    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'environment', environmentId: 'env-1' }}
        agent="codex"
      />
    )

    expect(mocks.messageListProps?.allowFileUriLinks).toBe(true)
    expect(mocks.messageListProps?.onLinkClick).toBe(mocks.fileLinkClick)
  })

  // Turn status shipped Codex-first. Every structured session renders through the
  // same list, so it is not agent-gated.
  //
  // Upstream also asserts `runtimeContext` here, for transcript image previews.
  // That prop does not exist on this fork's message list, so there is nothing to
  // un-gate; it comes back with the image-preview work, not with this parity fix.
  it.each(['codex', 'claude'] as const)(
    'renders the same structured transcript chrome for %s',
    (agent) => {
      render(
        <NativeChatStructuredSession
          worktreeId="workspace"
          isVisible
          tabId="structured-tab-parity"
          sessionId="session-parity"
          target={{ kind: 'local' }}
          agent={agent}
        />
      )

      expect(mocks.messageListProps?.showTurnStatus).toBe(true)
    }
  )

  it('places background monitoring above the usable composer and stops without an active turn', async () => {
    mocks.monitoringBackgroundTasks = true
    mocks.backgroundTasks = [
      { id: 'task-command', kind: 'command', description: 'sleep 180' },
      { id: 'task-agent', kind: 'agent' }
    ]
    mocks.stopBackgroundTask.mockResolvedValue({ cancelled: true })

    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="structured-tab-background"
        sessionId="session-background"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )

    const status = screen
      .getByText('Monitoring background tasks')
      .closest('[data-native-chat-background-tasks="true"]')
    const composer = screen.getByTestId('structured-composer')
    if (!status) {
      throw new Error('background task status was not rendered')
    }
    expect(status.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(mocks.composerProps?.isWorking).toBe(false)
    expect(screen.queryByRole('list', { name: 'Running background tasks' })).toBeNull()

    const disclosure = screen.getByRole('button', { name: 'Monitoring background tasks' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('list', { name: 'Running background tasks' })).toBeTruthy()
    expect(screen.getByText('sleep 180')).toBeTruthy()
    expect(screen.getByText('Background agent')).toBeTruthy()

    // With `supportsBackgroundTaskStop` false the strip offers only the untargeted
    // control, which now names itself rather than reading a bare "Stop".
    fireEvent.click(screen.getByRole('button', { name: 'Stop background tasks' }))
    await waitFor(() => expect(mocks.stopBackgroundTask).toHaveBeenCalledOnce())
  })

  it('routes a bare model command to the native option picker', async () => {
    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    const dispatchCommand = mocks.composerProps?.structuredTransport?.dispatchCommand as
      | ((text: string) => Promise<{ accepted: boolean }>)
      | undefined

    await act(async () => {
      await expect(dispatchCommand?.('/model')).resolves.toMatchObject({ accepted: true })
    })

    expect(mocks.composerProps?.structuredTransport?.optionPickerRequest).toEqual({
      id: 'model',
      sequence: 1
    })
  })

  it('retries an unconfirmed transport send and clears the delivery notice', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValueOnce({
      ok: true,
      value: {
        submission: {
          clientMessageId: 'client-1',
          dispatchState: 'accepted'
        }
      }
    })

    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('hello', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))

    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull())
  })

  it('resends a transport-unconfirmed head so later messages are not wedged', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="structured-tab-wedge"
        sessionId="session-wedge"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())

    expect(send?.('second', [])).toBe(true)
    // The head is probed automatically, clears, and the queue drains.
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(3), { timeout: 10000 })
    await waitFor(() => expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull())
  }, 20000)

  it('probes without retryUnknown so the host cannot redispatch', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="structured-tab-probe-flag"
        sessionId="session-probe-flag"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2), { timeout: 10000 })

    const first = mocks.call.mock.calls[0]?.[2] as Record<string, unknown>
    const probe = mocks.call.mock.calls[1]?.[2] as Record<string, unknown>
    expect(probe.retryUnknown).toBeUndefined()
    // Same operation id: both dedupe layers key off it.
    expect((probe.envelope as { clientOperationId: string }).clientOperationId).toBe(
      (first.envelope as { clientOperationId: string }).clientOperationId
    )
  }, 20000)

  it('parks a host-confirmed unknown instead of probing it', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="structured-tab-parked"
        sessionId="session-parked"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    const sent = mocks.call.mock.calls[0]?.[2] as { envelope: { clientOperationId: string } }
    // The host now reports it as an unresolved unknown: redispatch is the user's call.
    mocks.submissions = [
      {
        clientMessageId: sent.envelope.clientOperationId,
        fence: 1,
        payloadFingerprint: 'fp',
        dispatchState: 'unknown',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    ]
    // Queue a second message purely to re-render so the effect observes the
    // new submissions; it must stay wedged behind the parked head.
    await act(async () => {
      send?.('second', [])
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    })
    expect(mocks.call).toHaveBeenCalledOnce()
  }, 20000)

  it('still probes while streaming batches rebuild the submissions array', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    const makeView = (): React.ReactElement => (
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="structured-tab-churn"
        sessionId="session-churn"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    const { rerender } = render(makeView())

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    // Each batch mints a fresh submissions array for an unrelated message. An
    // array-identity dependency restarts the backoff on every one of these, so a
    // stream that outlasts the delay would never let the probe fire.
    for (let index = 0; index < 12; index += 1) {
      mocks.submissions = [
        {
          clientMessageId: `other-${index}`,
          fence: 1,
          payloadFingerprint: 'fp',
          dispatchState: 'accepted',
          providerItemId: null,
          reason: null,
          submittedAt: index,
          resolvedAt: index
        }
      ]
      await act(async () => {
        rerender(makeView())
        await new Promise((resolve) => setTimeout(resolve, 250))
      })
    }

    // Asserted with no trailing grace period: the probe must have fired *during*
    // the stream, not after it went quiet.
    expect(mocks.call).toHaveBeenCalledTimes(2)
  }, 20000)

  it('restarts probe delay when the runtime target changes', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    const makeView = (
      target: { kind: 'local' } | { kind: 'environment'; environmentId: string }
    ) => (
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="structured-tab-target-switch"
        sessionId="session-target-switch"
        target={target}
        agent="codex"
      />
    )
    const { rerender } = render(makeView({ kind: 'local' }))
    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    rerender(makeView({ kind: 'environment', environmentId: 'env-1' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(mocks.call).toHaveBeenCalledOnce()
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2), { timeout: 1500 })
  }, 10000)

  it('never auto-probes an entry the user already force-retried', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    // Both the original send and the user's explicit Retry fail at the transport.
    mocks.call.mockRejectedValue(new Error('socket closed'))

    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="structured-tab-forced"
        sessionId="session-forced"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())

    // User force-retries: this request legitimately carries retryUnknown.
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    const forcedRequest = mocks.call.mock.calls[1]?.[2] as Record<string, unknown> | undefined
    expect(forcedRequest?.retryUnknown).toBe(true)

    // That retry also failed at the transport. The probe must NOT pick it up, or it
    // would re-send retryUnknown automatically and redispatch to the agent.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    })
    expect(mocks.call).toHaveBeenCalledTimes(2)
  }, 20000)

  it('does not hot-loop when the host answers pending', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'pending' } }
    })

    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        isVisible
        tabId="structured-tab-pending"
        sessionId="session-pending"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    // A pending row parks the entry under the backoff instead of re-dispatching
    // immediately. Without that, this window is an unbounded back-to-back RPC flood.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500))
    })
    expect(mocks.call.mock.calls.length).toBeLessThanOrEqual(3)
  }, 20000)

  it('keeps probing past the old five-attempt budget', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValue(new Error('socket closed'))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(
        <NativeChatStructuredSession
          worktreeId="workspace"
          isVisible
          tabId="structured-tab-budget"
          sessionId="session-budget"
          target={{ kind: 'local' }}
          agent="codex"
        />
      )

      const send = mocks.composerProps?.structuredTransport?.send as
        | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
        | undefined
      expect(send?.('first', [])).toBe(true)

      // Backoff is 1+2+4+8+16 = 31s for five probes, which was the old hard budget.
      // Step past it; a seventh call proves the probe re-arms instead of giving up.
      for (let step = 0; step < 12; step += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(8_000)
        })
      }
      expect(mocks.call.mock.calls.length).toBeGreaterThanOrEqual(7)
    } finally {
      vi.useRealTimers()
    }
  }, 30000)

  it('passes the structured transcript to its single work header', () => {
    render(
      <NativeChatStructuredSession
        worktreeId="workspace"
        tabId="tab"
        sessionId="session"
        agent="claude"
        target={{ kind: 'local' }}
        isVisible
      />
    )
    expect(screen.getAllByTestId('structured-work-header')).toHaveLength(1)
    expect(mocks.header).toHaveBeenLastCalledWith(
      expect.objectContaining({
        worktreeId: 'workspace',
        messages: expect.arrayContaining([expect.objectContaining({ id: 'message-1' })])
      })
    )
  })
})
