// Why: locks the one reply a prompt hook may give — session prep's block, which withholds a
// terminal "create sessions for …" from the agent — and that every other prompt still gets 204.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'

describe('AgentHookServer UserPromptSubmit interception', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
  })

  const prompt = (text: string) =>
    buildBody({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: 's-1' })

  it('answers with the interceptor block reply as JSON', async () => {
    const interceptor = vi.fn(async () => ({ decision: 'block' as const, reason: 'diverted' }))
    server.setPromptSubmitInterceptor(interceptor)

    const response = await postHookEvent(server, prompt('create sessions for a and b'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ decision: 'block', reason: 'diverted' })
    expect(interceptor).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ paneKey: expect.any(String), hookEventName: 'UserPromptSubmit' })
    )
  })

  it('stays silent (204) when the interceptor passes or fails', async () => {
    server.setPromptSubmitInterceptor(async () => null)
    await expect(postHookEvent(server, prompt('fix the login'))).resolves.toMatchObject({
      status: 204
    })

    server.setPromptSubmitInterceptor(async () => {
      throw new Error('boom')
    })
    await expect(
      postHookEvent(server, prompt('create sessions for a and b'))
    ).resolves.toMatchObject({
      status: 204
    })
  })

  it('never intercepts while the agent in that pane is working', async () => {
    server.setPromptSubmitInterceptor(async () => null)
    await postHookEvent(server, prompt('start the refactor'))

    const interceptor = vi.fn(async () => ({ decision: 'block' as const, reason: 'diverted' }))
    server.setPromptSubmitInterceptor(interceptor)
    const response = await postHookEvent(server, prompt('create sessions for a and b'))

    expect(response.status).toBe(204)
    expect(interceptor).not.toHaveBeenCalled()
  })
})
