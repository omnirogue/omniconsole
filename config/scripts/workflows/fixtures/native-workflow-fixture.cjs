const { appendFileSync } = require('node:fs')

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (part) => {
  // setEncoding('utf8') above makes every chunk a string at runtime, but the event
  // signature still admits a Buffer, which the type-aware lint rejects for '+'.
  input += String(part)
})
process.stdin.on('end', () => {
  const { agent, attemptId, ledgerPath, model, value } = JSON.parse(input)
  appendFileSync(ledgerPath, `${JSON.stringify({ attemptId, pid: process.pid })}\n`)
  if (agent === 'codex') {
    process.stdout.write(
      [
        { type: 'thread.started', thread_id: attemptId },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
        { type: 'turn.completed', usage: {} }
      ]
        .map((event) => JSON.stringify(event))
        .join('\n')
    )
    return
  }
  process.stdout.write(
    JSON.stringify(
      agent === 'claude'
        ? {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: attemptId,
            structured_output: value,
            modelUsage: { [model]: {} },
            usage: {}
          }
        : {
            stopReason: 'end_turn',
            sessionId: attemptId,
            requestId: attemptId,
            structuredOutput: value,
            modelUsage: { [model]: {} },
            usage: {}
          }
    )
  )
})
