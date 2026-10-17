import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendRuntimePtyInputVerified = vi.fn(async () => true)
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInputVerified: (...args: unknown[]) => sendRuntimePtyInputVerified(...(args as [])),
  sendRuntimePtyInput: () => true
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: null }) } }))

import type {
  SessionInputReceipt,
  SessionInputSubmission
} from '../../../shared/session-input-program'
import { wrapTerminalBracketedPasteText } from '@/components/terminal-pane/terminal-bracketed-paste'
import {
  POST_PASTE_SUBMIT_DELAY_MS,
  sendBracketedPasteToAgent
} from './agent-bracketed-paste-transaction'

type WindowWithApi = {
  api?: {
    pty?: {
      submitSessionInput?: (submission: SessionInputSubmission) => Promise<SessionInputReceipt>
    }
  }
}

const submitted: SessionInputSubmission[] = []
let nextStatus: SessionInputReceipt['status'] = 'delivered'

describe('chain step paste through the host session input queue', () => {
  beforeEach(() => {
    submitted.length = 0
    nextStatus = 'delivered'
    sendRuntimePtyInputVerified.mockClear()
    ;(globalThis as { window?: WindowWithApi }).window = {
      api: {
        pty: {
          submitSessionInput: async (submission) => {
            submitted.push(submission)
            return { clientMessageId: submission.clientMessageId, status: nextStatus }
          }
        }
      }
    }
  })
  afterEach(() => {
    delete (globalThis as { window?: WindowWithApi }).window
  })

  it('submits the paste, its gap and Enter as one item and writes no bytes itself', async () => {
    const delivered = await sendBracketedPasteToAgent({
      ptyId: 'pty-1',
      content: 'run the chain step',
      submit: true
    })
    expect(delivered).toBe(true)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatchObject({
      ptyId: 'pty-1',
      origin: 'chain',
      body: 'run the chain step'
    })
    expect(submitted[0]!.program.steps).toEqual([
      { kind: 'write', data: wrapTerminalBracketedPasteText('run the chain step') },
      { kind: 'pause', ms: POST_PASTE_SUBMIT_DELAY_MS },
      { kind: 'write', data: '\r' }
    ])
    expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })

  it("keeps the agent's retry Enter inside the same item", async () => {
    await sendBracketedPasteToAgent({
      ptyId: 'pty-1',
      content: 'codex step',
      submit: true,
      agent: 'codex'
    })
    expect(submitted[0]!.program.steps).toEqual([
      { kind: 'write', data: wrapTerminalBracketedPasteText('codex step') },
      { kind: 'pause', ms: POST_PASTE_SUBMIT_DELAY_MS },
      { kind: 'write', data: '\r' },
      { kind: 'pause', ms: 1200 },
      { kind: 'write', data: '\r' }
    ])
  })

  it('leaves an unsubmitted draft without a submit step', async () => {
    await sendBracketedPasteToAgent({ ptyId: 'pty-1', content: 'draft only', submit: false })
    expect(submitted[0]!.program.steps).toEqual([
      { kind: 'write', data: wrapTerminalBracketedPasteText('draft only') }
    ])
  })

  it('reports a refused duplicate as not delivered rather than claiming a send', async () => {
    nextStatus = 'duplicate-rejected'
    await expect(
      sendBracketedPasteToAgent({ ptyId: 'pty-1', content: 'twice', submit: true })
    ).resolves.toBe(false)
  })

  it('writes the bytes itself when the caller re-checks authority per write', async () => {
    const beforeWrite = vi.fn()
    await sendBracketedPasteToAgent({
      ptyId: 'pty-1',
      content: 'authority bound',
      submit: true,
      beforeWrite
    })
    expect(submitted).toHaveLength(0)
    expect(sendRuntimePtyInputVerified).toHaveBeenCalled()
    expect(beforeWrite).toHaveBeenCalled()
  })

  it('writes the bytes itself for a PTY owned by a remote runtime', async () => {
    await sendBracketedPasteToAgent({
      ptyId: 'remote:env%2Fa@@handle-1',
      content: 'remote step',
      submit: true
    })
    expect(submitted).toHaveLength(0)
    expect(sendRuntimePtyInputVerified).toHaveBeenCalled()
  })
})
