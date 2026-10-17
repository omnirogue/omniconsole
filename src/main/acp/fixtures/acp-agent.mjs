import { createInterface } from 'node:readline'

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
const sessionId = 'fixture-acp-session'
let turn
const configOptions = [
  {
    id: 'model',
    category: 'model',
    currentValue: 'fixture-1',
    options: [
      { value: 'fixture-1', name: 'Fixture One' },
      { value: 'fixture-2', name: 'Fixture Two' }
    ]
  }
]
const update = (value) => send({ method: 'session/update', params: { sessionId, update: value } })
const finish = () => {
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' })
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Fixture complete 🦋' }
  })
  send({ id: turn, result: { stopReason: 'end_turn' } })
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    const message = JSON.parse(line)
    switch (message.method) {
      case 'initialize':
        send({
          id: message.id,
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }
        })
        break
      case 'session/new':
        send({ id: message.id, result: { sessionId, configOptions } })
        break
      case 'session/load':
        if (message.params.sessionId !== sessionId) {
          throw new Error('Wrong resume identity')
        }
        send({ id: message.id, result: { configOptions } })
        break
      case 'session/set_config_option':
        configOptions[0].currentValue = message.params.value
        send({ id: message.id, result: { configOptions } })
        break
      case 'session/prompt':
        turn = message.id
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Fixture tool',
          status: 'pending',
          rawInput: { fixture: true }
        })
        send({
          id: 'permission-1',
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 'tool-1', title: 'Allow fixture tool' },
            options: [
              { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'no', name: 'Reject', kind: 'reject_once' }
            ]
          }
        })
        break
      case 'session/cancel':
        send({ id: turn, result: { stopReason: 'cancelled' } })
        break
      default:
        if (message.id === 'permission-1') {
          if (message.result?.outcome?.optionId !== 'yes') {
            throw new Error('Permission was not selected')
          }
          finish()
        }
    }
  })
  .on('close', () => process.exit(0))
