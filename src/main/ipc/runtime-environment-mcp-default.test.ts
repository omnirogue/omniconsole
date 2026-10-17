import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import { encodePairingOffer } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import { setOmniConsoleMcpSignInResolver } from '../mcp/omni-console-mcp-auth'

const { sendRequest, supportCall } = vi.hoisted(() => ({
  sendRequest: vi.fn(),
  supportCall: vi.fn()
}))
vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: sendRequest,
  subscribeRemoteRuntimeRequest: vi.fn()
}))
vi.mock('./runtime-environment-support-routing', () => ({
  executeSupportRoutedCall: supportCall,
  shouldRouteCallBySupport: () => true,
  shouldRouteSubscriptionBySupport: () => false,
  subscribeSupportRoutedRuntimeEnvironment: vi.fn()
}))

import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

let userDataPath: string
let environmentId: string
const success = { id: 'request', ok: true, result: {}, _meta: { runtimeId: 'remote-host' } }

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'omni-mcp-origin-'))
  environmentId = addEnvironmentFromPairingCode(userDataPath, {
    name: 'remote',
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'device-token',
      publicKeyB64: publicKeyToBase64(generateKeyPair().publicKey)
    })
  }).id
  sendRequest.mockReset().mockResolvedValue(success)
  supportCall.mockReset().mockResolvedValue(success)
})

afterEach(() => {
  setOmniConsoleMcpSignInResolver(null)
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('desktop MCP launch origin', () => {
  it.each([
    'agentSession.create',
    'agentSession.ensure',
    'agentSession.hold',
    'terminal.create',
    'terminal.createAgentSession',
    'terminal.ensureAgentSession'
  ])('stamps %s without changing its parameters or using shared-control', async (method) => {
    const signedIn = vi.fn(() => true)
    setOmniConsoleMcpSignInResolver(signedIn)
    const params = Object.freeze({ worktree: 'id:workspace', envelope: { operationId: 'same' } })
    await callRuntimeEnvironment(userDataPath, environmentId, method, params, 500)
    expect(signedIn).toHaveBeenCalledWith(userDataPath)
    expect(sendRequest).toHaveBeenCalledWith(
      expect.anything(),
      method,
      params,
      500,
      { omniConsoleMcpDefault: true },
      undefined,
      expect.any(Array)
    )
    expect(sendRequest.mock.calls[0][2]).toBe(params)
    expect(supportCall).not.toHaveBeenCalled()
  })

  it('does not trust a caller hint when signed out', async () => {
    await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'agentSession.create',
      {},
      500,
      undefined,
      { omniConsoleMcpDefault: true }
    )
    expect(sendRequest).not.toHaveBeenCalled()
    expect(supportCall).toHaveBeenCalledWith(expect.objectContaining({ envelope: undefined }))
  })

  it('does not attach the hint to unrelated methods', async () => {
    setOmniConsoleMcpSignInResolver(() => true)
    await callRuntimeEnvironment(userDataPath, environmentId, 'repo.list', {}, 500)
    expect(sendRequest).not.toHaveBeenCalled()
    expect(supportCall).toHaveBeenCalledWith(expect.objectContaining({ envelope: undefined }))
  })

  it('reads current sign-in for each call and preserves independent envelope fields', async () => {
    let signedIn = true
    setOmniConsoleMcpSignInResolver(() => signedIn)
    const envelope = { orchestrationRequestId: 'caller-id' }
    await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'agentSession.ensure',
      {},
      500,
      undefined,
      envelope
    )
    expect(sendRequest.mock.calls[0][4]).toEqual({
      orchestrationRequestId: 'caller-id',
      omniConsoleMcpDefault: true
    })
    signedIn = false
    await callRuntimeEnvironment(userDataPath, environmentId, 'agentSession.ensure', {}, 500)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(supportCall).toHaveBeenCalledWith(expect.objectContaining({ envelope: undefined }))
    expect(envelope).toEqual({ orchestrationRequestId: 'caller-id' })
  })
})
