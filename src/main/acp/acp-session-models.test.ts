import { describe, expect, it } from 'vitest'
import { indexAcpSessionConfiguration } from './acp-session-models'
import { applyAcpSessionOption } from './acp-session-config'
import { fakeConnection } from './acp-test-connection'

describe('ACP model selection', () => {
  it('uses legacy set_model only for a session that reported legacy models', async () => {
    const config = indexAcpSessionConfiguration({
      models: {
        currentModelId: 'one',
        availableModels: [
          { modelId: 'one', name: 'One' },
          { modelId: 'two', name: 'Two' }
        ]
      }
    })
    expect(config.result.models.map((model) => model.id)).toEqual(['one', 'two'])
    const connection = fakeConnection({})
    const updated = await applyAcpSessionOption({
      connection,
      config,
      acpSessionId: 'session',
      key: 'model',
      value: 'two'
    })
    expect(connection.calls).toEqual([
      { method: 'session/set_model', params: { sessionId: 'session', modelId: 'two' } }
    ])
    expect(updated.result.current.model).toBe('two')
  })

  it('keeps the server acknowledged config instead of asserting the requested value', async () => {
    const configOptions = [
      {
        id: 'model',
        category: 'model',
        currentValue: 'one',
        options: [{ value: 'one' }, { value: 'two' }]
      }
    ]
    const connection = fakeConnection({ onRequest: () => ({ configOptions }) })
    const updated = await applyAcpSessionOption({
      connection,
      config: indexAcpSessionConfiguration({ configOptions }),
      acpSessionId: 'session',
      key: 'model',
      value: 'two'
    })
    expect(updated.result.current.model).toBe('one')
  })
})
