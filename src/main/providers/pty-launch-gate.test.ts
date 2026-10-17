import { describe, expect, it, vi } from 'vitest'
import { PtyLaunchGate } from './pty-launch-gate'
import { buildPtyLaunchGateCommand } from './pty-launch-gate-command'
import { buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'

function fixture(reportsChildExitStatus = true) {
  const write = vi.fn()
  const readBirth = vi.fn(async (): Promise<number | null> => 1700000000000)
  const isLive = vi.fn(() => true)
  const gate = new PtyLaunchGate({
    request: { version: 1, launchId: 'dispatch-test', startupCommandMode: 'exec' },
    command: 'codex',
    ptyId: 'pty-test',
    incarnationId: 'incarnation-test',
    pid: 123,
    reportsChildExitStatus,
    write,
    readBirth,
    isLive
  })
  return { gate, write, readBirth, isLive }
}

describe('process-owner launch gate', () => {
  it('holds all input and releases it once across concurrent replay', async () => {
    const { gate, write } = fixture()
    gate.submitStartup('exec codex\n')
    const receipt = await gate.prepare()
    gate.write('queued input\n')
    expect(write).not.toHaveBeenCalled()
    expect(receipt).toMatchObject({ state: 'closed', pid: 123, startupCommandMode: 'exec' })
    const release = { gate: receipt, startAcknowledgement: 'persisted-start:session:attempt' }
    const [first, replay] = await Promise.all([gate.release(release), gate.release(release)])
    expect(first).toEqual(replay)
    expect(write.mock.calls).toEqual([['exec codex\n'], ['queued input\n']])
    await expect(
      gate.release({ ...release, startAcknowledgement: 'another-start' })
    ).rejects.toThrow('acknowledgement_conflict')
    await expect(gate.prepare()).rejects.toThrow('not_closed')
  })

  it.each(['pid', 'processStartTimeMs', 'incarnationId', 'gateId', 'ptyId', 'launchId'] as const)(
    'fences a mismatched %s',
    async (field) => {
      const { gate, write } = fixture()
      const receipt = await gate.prepare()
      const forged = { ...receipt, [field]: typeof receipt[field] === 'number' ? 999 : 'wrong' }
      gate.write('exec codex\n')
      await expect(
        gate.release({ gate: forged, startAcknowledgement: 'persisted-start' })
      ).rejects.toThrow('identity_mismatch')
      expect(write).not.toHaveBeenCalled()
    }
  )

  it('fences competing acknowledgements that both entered before asynchronous identity checks settled', async () => {
    const { gate, write } = fixture()
    const receipt = await gate.prepare()
    gate.submitStartup('exec codex\n')
    const outcomes = await Promise.allSettled([
      gate.release({ gate: receipt, startAcknowledgement: 'first-start' }),
      gate.release({ gate: receipt, startAcknowledgement: 'competing-start' })
    ])
    expect(outcomes[0].status).toBe('fulfilled')
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: new Error('pty_launch_gate_acknowledgement_conflict')
    })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('keeps unknown birth and PID reuse closed', async () => {
    const { gate, readBirth, write } = fixture()
    readBirth.mockResolvedValueOnce(null)
    await expect(gate.prepare()).rejects.toThrow('birth_unverifiable')
    const receipt = await gate.prepare()
    gate.submitStartup('exec codex\n')
    readBirth.mockResolvedValue(1700000001000)
    await expect(
      gate.release({ gate: receipt, startAcknowledgement: 'persisted-start' })
    ).rejects.toThrow('identity_unverifiable')
    expect(write).not.toHaveBeenCalled()
  })

  it('rechecks exit/teardown after the asynchronous birth read', async () => {
    const { gate, isLive, readBirth, write } = fixture()
    const receipt = await gate.prepare()
    readBirth.mockImplementation(async () => {
      isLive.mockReturnValue(false)
      return receipt.processStartTimeMs
    })
    await expect(
      gate.release({ gate: receipt, startAcknowledgement: 'persisted-start' })
    ).rejects.toThrow('identity_unverifiable')
    expect(write).not.toHaveBeenCalled()
  })

  it('requires acknowledgement and never relabels a login wrapper as exec', async () => {
    const { gate, write } = fixture(false)
    const receipt = await gate.prepare()
    expect(receipt).toMatchObject({ startupCommandMode: 'shell', reportsChildExitStatus: false })
    await expect(gate.release({ gate: receipt, startAcknowledgement: '' })).rejects.toThrow(
      'acknowledgement_required'
    )
    gate.close()
    gate.write('late readiness timer\n')
    expect(write).not.toHaveBeenCalled()
  })

  it('does not replay a partially failed release', async () => {
    const { gate, write } = fixture()
    const receipt = await gate.prepare()
    gate.submitStartup('exec codex\n')
    write.mockImplementationOnce(() => {
      throw new Error('write failed')
    })
    const release = { gate: receipt, startAcknowledgement: 'persisted-start' }
    await expect(gate.release(release)).rejects.toThrow('write failed')
    await expect(gate.release(release)).rejects.toThrow('identity_unverifiable')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('keeps queued input behind startup when admission precedes shell readiness', async () => {
    const { gate, write } = fixture()
    const receipt = await gate.prepare()
    gate.write('queued input\n')
    await gate.release({ gate: receipt, startAcknowledgement: 'persisted-start' })
    expect(write).not.toHaveBeenCalled()
    gate.submitStartup('exec codex\n')
    expect(write.mock.calls).toEqual([['exec codex\n'], ['queued input\n']])
  })
})

describe('explicit exec launch disposition', () => {
  const request = { version: 1, launchId: 'dispatch-test', startupCommandMode: 'exec' } as const
  it('preserves a configured launcher and quoted arguments', () => {
    expect(buildPtyLaunchGateCommand('/opt/bin/codex --prompt "hello world"', request)).toBe(
      'exec /opt/bin/codex --prompt "hello world"'
    )
    expect(buildPtyLaunchGateCommand('cd elsewhere && codex')).toBe('cd elsewhere && codex')
  })
  it.each([
    'cd somewhere && codex',
    'codex; exit 0',
    'A=1 codex',
    'codex $(echo --flag)',
    'codex\nexit',
    'exec codex',
    'codex\rexit',
    'codex\n',
    "codex 'one'\nexit",
    'codex \\\nexit',
    'codex "a\\\nb"',
    "codex 'a\\'b'\n'",
    "codex 'unclosed\nprompt",
    "codex 'line one\nline two'; exit 0",
    "codex 'line one\nline two' && exit 0",
    "codex 'line one\nline two' | tee out",
    "codex 'line one\nline two' $(echo --flag)"
  ])('refuses unsupported exec input %j', (command) => {
    expect(() => buildPtyLaunchGateCommand(command, request)).toThrow('exec_command_unsupported')
  })
  it.each([
    "/opt/bin/codex 'line one\nline two'",
    "/opt/bin/codex 'line one\r\nline two'",
    '/opt/bin/codex "line one\nline two"',
    "/opt/bin/codex 'it'\"'\"'s\nfine'"
  ])('keeps a line break inside one quoted word %j', (command) => {
    expect(buildPtyLaunchGateCommand(command, request)).toBe(`exec ${command}`)
  })
  it('keeps multi-line quoted prompts unchanged outside exec mode', () => {
    expect(buildPtyLaunchGateCommand("codex 'a\nb'\nexit")).toBe("codex 'a\nb'\nexit")
  })
})

describe('managed provider startup through the exec gate', () => {
  const request = { version: 1, launchId: 'managed-test', startupCommandMode: 'exec' } as const
  const prompt = [
    '# Brief',
    '',
    'Fix the user\'s launch; keep `$HOME`, \\d+ and "quotes" literal.',
    '- step one && step two; done | tee',
    '$(not run)'
  ].join('\n')
  it.each([
    {
      agent: 'claude' as const,
      executable: '/Users/person/.local/share/claude/versions/2.1.296',
      agentArgs: ['--strict-mcp-config', '--mcp-config', '/tmp/managed tools/mcp.json']
    },
    {
      agent: 'codex' as const,
      executable:
        '/Users/person/.nvm/versions/node/v22.22.3/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
      agentArgs: [
        '--disable',
        'apps',
        '-c',
        'mcp_servers.omni_native={command="/usr/bin/omni",args=["mcp"],enabled=true,required=true}'
      ]
    }
  ])(
    'admits the real $agent multi-line launch as one exec command',
    ({ agent, executable, agentArgs }) => {
      const plan = buildAgentStartupPlan({
        agent,
        prompt,
        cmdOverrides: { [agent]: quoteStartupArg(executable, 'posix') },
        agentArgs: agentArgs.map((arg) => quoteStartupArg(arg, 'posix')).join(' '),
        platform: 'darwin',
        shell: 'posix',
        allowEmptyPromptLaunch: true
      })
      expect(plan).not.toBeNull()
      let command = plan!.launchCommand
      if (agent === 'claude') {
        command += ` --session-id ${quoteStartupArg('7f0c1d2e-0000-4000-8000-000000000000', 'posix')}`
      }
      expect(command).toContain('\n')
      expect(buildPtyLaunchGateCommand(command, request)).toBe(`exec ${command}`)
    }
  )
})
