const fs = require('node:fs')

// This opt-in fixture accepts only selector digits and journals every received byte.
module.exports = function createNativeQuestionMode(controlPath) {
  let current = null
  let answered = false
  let reading = false
  let lastRevision = null

  const question = (control) => ({
    header: 'Test marker',
    question: `Paired fixture ${control.revision}: pick the test marker`,
    multiSelect: false,
    options: [
      { label: 'Blue', description: 'Choose Blue as the test marker' },
      { label: 'Green', description: 'Choose Green as the test marker' }
    ]
  })

  async function postHook(control, payload) {
    // Why: surviving PTYs must reread rotated coordinates, as the real Claude hook does.
    const endpointPath = process.env.ORCA_AGENT_HOOK_ENDPOINT
    if (!endpointPath) {
      throw new Error('Fixture requires the managed stable hook endpoint file')
    }
    const values = Object.fromEntries(
      fs
        .readFileSync(endpointPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [key, ...rest] = line.replace(/^set\s+/i, '').split('=')
          return [key, rest.join('=')]
        })
    )
    const endpoint = {
      port: values.ORCA_AGENT_HOOK_PORT,
      token: values.ORCA_AGENT_HOOK_TOKEN,
      env: values.ORCA_AGENT_HOOK_ENV,
      version: values.ORCA_AGENT_HOOK_VERSION
    }
    if (Object.values(endpoint).some((value) => !value)) {
      throw new Error('Fixture stable hook endpoint file is missing required fields')
    }
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': endpoint.token
      },
      body: JSON.stringify({
        paneKey: control.paneKey,
        tabId: control.paneKey.split(':')[0],
        worktreeId: control.worktreeId,
        env: endpoint.env,
        version: endpoint.version,
        agentPid: process.pid,
        agentPidHost: 'local',
        payload: { session_id: control.sessionId, ...payload }
      })
    })
    fs.appendFileSync(
      `${control.receiptPath}.hooks.jsonl`,
      `${JSON.stringify({
        event: payload.hook_event_name,
        toolUseId: payload.tool_use_id || null,
        endpointSource: 'managed-stable-file',
        endpointPath,
        port: endpoint.port,
        credentialsRefreshedSinceQuestion: endpoint.token !== control.endpoint.token,
        status: response.status
      })}\n`
    )
    if (response.status !== 204) {
      throw new Error(`Fixture hook returned ${response.status}`)
    }
  }

  function render() {
    const lines = [
      '\x1b[H\x1b[2J[GOLDEN_STUB_AGENT_READY]',
      `[GOLDEN_STUB_AGENT_PID] ${process.pid}`
    ]
    if (current && !answered) {
      const q = question(current)
      lines.push(
        `☐ ${q.header}`,
        q.question,
        '❯ 1. Blue',
        '    Choose Blue as the test marker',
        '  2. Green',
        '    Choose Green as the test marker',
        '  3. Type something.',
        '─'.repeat(60),
        '  4. Chat about this',
        'Enter to select · ↑/↓ to navigate · Esc to cancel'
      )
    } else if (current) {
      lines.push(
        `FLEET_UI_RECEIPT_${current.revision}=${answered}`,
        '✻ Working… (esc to interrupt)'
      )
    }
    process.stdout.write(`\x1b]0;✳ Claude Code\x07${lines.join('\r\n')}`)
  }

  async function refresh() {
    if (reading || !fs.existsSync(controlPath)) {
      return
    }
    reading = true
    try {
      const next = JSON.parse(fs.readFileSync(controlPath, 'utf8'))
      if (next.revision === lastRevision) {
        return
      }
      lastRevision = next.revision
      current = next
      answered = false
      render()
      if (!next.screenOnly) {
        await postHook(next, {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'Choose a test marker.'
        })
        await postHook(next, {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_use_id: `fixture-${next.revision}`,
          tool_input: { questions: [question(next)] }
        })
      }
    } catch (error) {
      process.stderr.write(`Fixture question failed: ${error.message}\n`)
    } finally {
      reading = false
    }
  }
  setInterval(() => {
    void refresh()
  }, 100)

  return {
    render,
    consume(input) {
      if (!current) {
        return
      }
      fs.appendFileSync(
        current.receiptPath,
        `${JSON.stringify({ revision: current.revision, input })}\n`
      )
      if (answered || !/^[12]$/.test(input)) {
        return
      }
      answered = input === '1' ? 'Blue' : 'Green'
      render()
      void postHook(current, {
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: `fixture-${current.revision}`,
        tool_response: { answer: answered }
      }).catch((error) => process.stderr.write(`Fixture answer hook failed: ${error.message}\n`))
    }
  }
}
