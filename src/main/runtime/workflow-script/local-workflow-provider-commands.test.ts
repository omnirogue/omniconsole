import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import { buildWorkflowClaudeArgs } from '../../../shared/workflow-claude-command'
import {
  buildWorkflowCodexArgs,
  WORKFLOW_CODEX_PERMISSION_PROFILE
} from '../../../shared/workflow-codex-command'
import { workflowAgentInstructions } from '../../../shared/workflow-agent-instructions'
import { WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS } from '../../../shared/workflow-grok-command'
import { routeRevision } from './local-workflow-provider-catalog'
import {
  workflowCurrentProgram,
  workflowLaunchCommand,
  workflowLaunchMode,
  workflowLaunchPrompt
} from './local-workflow-provider-commands'
import { workflowCodexHiddenPaths, workflowHomeFolder } from './local-workflow-read-scope'
import { AUDIT_NOVELTY_SCHEMA } from '../../../shared/workflow-audit-contracts'
import type { WorkflowProgramCall } from './workflow-program-context'

const attemptId = '83672522-9541-4b31-89f6-2ad3e39b2639'
const schema = {
  type: 'object',
  properties: { markdown: { type: 'string' } },
  required: ['markdown'],
  additionalProperties: false
}
const directories: string[] = []
const savedKey = process.env.GEMINI_API_KEY
const savedOpenAIKey = process.env.OPENAI_API_KEY
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  if (savedKey === undefined) {
    delete process.env.GEMINI_API_KEY
  } else {
    process.env.GEMINI_API_KEY = savedKey
  }
  if (savedOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY
  } else {
    process.env.OPENAI_API_KEY = savedOpenAIKey
  }
})

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function launchInput(
  call: Partial<WorkflowProgramCall> = {},
  rejection: string | null = null,
  problems: string | null = rejection
) {
  return {
    attemptId,
    ordinal: 1,
    problems,
    rejection,
    signal: new AbortController().signal,
    recordPreparation: vi.fn(),
    recordLaunch: vi.fn(),
    recordNoLaunch: vi.fn(),
    call: {
      id: 'answer/seat-1',
      seatId: 'seat-1',
      prompt: 'What does reserve() do?',
      dependencies: [],
      schema,
      validateSemantics: () => null,
      ...call
    }
  }
}

const claudeSeat: ResolvedLocalWorkflowSeat = {
  id: 'seat-1',
  agent: 'claude',
  accountId: 'system:claude',
  model: 'claude-opus-5',
  effort: 'high',
  lineage: 'anthropic',
  policyRevision: routeRevision('claude', join(homedir(), '.claude'))
}
const runtime = { getAgentAccountSettings: () => ({}) } as unknown as OrcaRuntimeService

describe('workflow launch mode and prompt', () => {
  it('keeps legacy argv only for frozen schema calls', () => {
    expect(workflowLaunchMode({}, {})).toEqual({
      access: 'frozen',
      output: 'schema',
      stream: false
    })
    expect(workflowLaunchMode({}, { output: 'text' })).toEqual({
      access: 'frozen',
      output: 'text',
      stream: true
    })
    expect(workflowLaunchMode({ access: 'workspace-read' }, {})).toEqual({
      access: 'workspace-read',
      output: 'schema',
      stream: true
    })
  })

  it('tells a retried model what was wrong without touching the first attempt', () => {
    expect(workflowLaunchPrompt('Question', null)).toBe('Question')
    expect(workflowLaunchPrompt('Question', 'missing markdown.')).toBe(
      'Question\n\nYour previous answer was rejected: missing markdown. Answer again and fix that.'
    )
  })

  it('treats only the current programs and workspace reads as new behaviour', () => {
    expect(workflowCurrentProgram({})).toBe(false)
    expect(workflowCurrentProgram({ councilProgramRevision: 4 })).toBe(false)
    expect(workflowCurrentProgram({ discoverProgramRevision: 5 })).toBe(false)
    // The working-agent revisions never launch through this adapter.
    expect(workflowCurrentProgram({ councilProgramRevision: 5 })).toBe(false)
    expect(workflowCurrentProgram({ discoverProgramRevision: 6 })).toBe(false)
    expect(workflowCurrentProgram({ councilProgramRevision: 6 })).toBe(true)
    expect(workflowCurrentProgram({ discoverProgramRevision: 7 })).toBe(true)
    expect(workflowCurrentProgram({ access: 'workspace-read' })).toBe(true)
    expect(workflowCurrentProgram({ audit: { version: 1 } })).toBe(true)
    expect(workflowCurrentProgram({ audit: { version: 2 } })).toBe(true)
    expect(workflowCurrentProgram({ audit: { version: 3 } })).toBe(true)
    expect(workflowCurrentProgram({ audit: { version: 4 } })).toBe(true)
    expect(workflowCurrentProgram({ audit: { version: 5 } })).toBe(true)
    expect(workflowCurrentProgram({ audit: { version: 99 } })).toBe(false)
  })
})

describe('workflow launch commands', () => {
  it('includes semantic repair instructions for frozen Audit schema retries', async () => {
    const input = launchInput(
      { id: 'audit/read/chunk-0001' },
      'Reader source ids must name every supplied item exactly once'
    )
    const command = await workflowLaunchCommand(
      runtime,
      { audit: { version: 1 } },
      claudeSeat,
      input,
      temporary('workflow-audit-retry-'),
      workflowLaunchMode({}, {})
    )
    expect(command.args).toEqual(
      buildWorkflowClaudeArgs({ model: 'claude-opus-5', effort: 'high', attemptId, schema })
    )
    expect(command.input).toContain(
      'Your previous answer was rejected: Reader source ids must name every supplied item exactly once.'
    )
    expect(input.call.prompt).toBe('What does reserve() do?')
  })
  it('keeps the legacy frozen Claude command byte for byte', async () => {
    const directory = temporary('workflow-commands-')
    const command = await workflowLaunchCommand(
      runtime,
      {},
      claudeSeat,
      launchInput(),
      directory,
      workflowLaunchMode({}, {})
    )
    expect(command.args).toEqual(
      buildWorkflowClaudeArgs({ model: 'claude-opus-5', effort: 'high', attemptId, schema })
    )
    expect(command.cwd).toBe(join(directory, 'inputs', attemptId))
    expect(command.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBeUndefined()
    expect(command.input).toBe('What does reserve() do?')
  })

  it('replays a legacy retry with its original prompt, rejected answer or not', async () => {
    const legacy = await workflowLaunchCommand(
      runtime,
      { councilProgramRevision: 4 },
      claudeSeat,
      launchInput({}, 'missing verdict'),
      temporary('workflow-commands-'),
      workflowLaunchMode({}, {})
    )
    expect(legacy.input).toBe('What does reserve() do?')
    const current = await workflowLaunchCommand(
      runtime,
      { councilProgramRevision: 6 },
      claudeSeat,
      launchInput({ output: 'text' }, 'the answer was empty'),
      temporary('workflow-commands-'),
      workflowLaunchMode({}, { output: 'text' })
    )
    expect(current.input).toContain('Your previous answer was rejected: the answer was empty.')
    // A timeout or a moved folder is not the model's fault, so the prompt stays as it was.
    const infrastructure = await workflowLaunchCommand(
      runtime,
      { councilProgramRevision: 6 },
      claudeSeat,
      launchInput({ output: 'text' }, null, 'workflow process did not complete successfully'),
      temporary('workflow-commands-'),
      workflowLaunchMode({}, { output: 'text' })
    )
    expect(infrastructure.input).toBe('What does reserve() do?')
  })

  it('runs Claude in the workspace with read tools and writes nothing there', async () => {
    const directory = temporary('workflow-commands-')
    const root = temporary('workflow-workspace-')
    const mode = { ...workflowLaunchMode({ access: 'workspace-read' }, { output: 'text' }), root }
    const command = await workflowLaunchCommand(
      runtime,
      { access: 'workspace-read' },
      claudeSeat,
      launchInput({ output: 'text' }, 'the answer was empty'),
      directory,
      mode
    )
    expect(command.cwd).toBe(root)
    expect(command.args[command.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
    expect(command.args).not.toContain('--json-schema')
    expect(command.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
    expect(command.input).toContain('Your previous answer was rejected: the answer was empty.')
    expect(readdirSync(root)).toEqual([])
  })

  it('refuses every route a workspace that holds the home folder, before writing anything', async () => {
    process.env.GEMINI_API_KEY = 'gemini-account-key'
    const gemini: ResolvedLocalWorkflowSeat = {
      ...claudeSeat,
      agent: 'gemini',
      accountId: 'system:gemini',
      model: 'gemini-3.8-flash',
      lineage: 'google',
      policyRevision: routeRevision('gemini', join(homedir(), '.gemini'))
    }
    for (const seat of [claudeSeat, gemini]) {
      for (const root of [workflowHomeFolder(), '/']) {
        const directory = temporary('workflow-commands-')
        await expect(
          workflowLaunchCommand(
            runtime,
            { access: 'workspace-read' },
            seat,
            launchInput({ output: 'text' }),
            directory,
            { ...workflowLaunchMode({ access: 'workspace-read' }, { output: 'text' }), root }
          )
        ).rejects.toThrow(`Agents can't read ${root}: it contains your home folder`)
        expect(readdirSync(directory)).toEqual([])
      }
    }
  })

  it('keeps Gemini settings, home and temp files under the attempt', async () => {
    process.env.GEMINI_API_KEY = 'gemini-account-key'
    const directory = temporary('workflow-commands-')
    const root = temporary('workflow-workspace-')
    const seat: ResolvedLocalWorkflowSeat = {
      id: 'seat-1',
      agent: 'gemini',
      accountId: 'system:gemini',
      model: 'gemini-3.8-flash',
      effort: 'high',
      lineage: 'google',
      policyRevision: routeRevision('gemini', join(homedir(), '.gemini'))
    }
    const command = await workflowLaunchCommand(
      runtime,
      { access: 'workspace-read' },
      seat,
      launchInput(),
      directory,
      { ...workflowLaunchMode({ access: 'workspace-read' }, {}), root }
    )
    const attempt = join(directory, 'inputs', attemptId)
    expect(command.program).toBe('gemini')
    expect(command.cwd).toBe(root)
    expect(command.env).toMatchObject({
      GEMINI_API_KEY: 'gemini-account-key',
      GEMINI_CLI_HOME: join(attempt, 'gemini-home'),
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(attempt, 'system-settings.json'),
      GEMINI_SYSTEM_MD: join(attempt, 'system.md'),
      TMPDIR: join(attempt, 'tmp'),
      GEMINI_CLI_TRUST_WORKSPACE: 'false',
      GEMINI_CLI_NO_RELAUNCH: 'true'
    })
    const settings = JSON.parse(readFileSync(join(attempt, 'system-settings.json'), 'utf8'))
    expect(
      settings.modelConfigs.customAliases['gemini-3.8-flash'].modelConfig.generateContentConfig
    ).toMatchObject({ thinkingConfig: { thinkingLevel: 'HIGH' }, responseJsonSchema: schema })
    expect(readFileSync(join(attempt, 'system.md'), 'utf8')).toBe(
      `${workflowAgentInstructions('workspace-read', 'schema')}\n`
    )
    expect(readdirSync(root)).toEqual([])
  })

  it('gives Codex the workspace through -C and a private home, or the legacy argv when frozen', async () => {
    process.env.OPENAI_API_KEY = 'ambient-test-value'
    const account = temporary('workflow-codex-account-')
    writeFileSync(join(account, 'auth.json'), '{}')
    const configured = {
      getAgentAccountSettings: () => ({
        agentAccountProfiles: [
          { id: 'chosen', agent: 'codex', label: 'Chosen', configDir: account }
        ]
      })
    } as unknown as OrcaRuntimeService
    const seat: ResolvedLocalWorkflowSeat = {
      id: 'seat-1',
      agent: 'codex',
      accountId: 'profile:chosen',
      model: 'gpt-5.6-sol',
      effort: 'high',
      lineage: 'openai',
      policyRevision: routeRevision('codex', account)
    }
    const directory = temporary('workflow-commands-')
    const root = temporary('workflow-workspace-')
    const read = await workflowLaunchCommand(
      configured,
      { access: 'workspace-read' },
      seat,
      launchInput({ output: 'text' }),
      directory,
      { ...workflowLaunchMode({ access: 'workspace-read' }, { output: 'text' }), root }
    )
    const attempt = join(directory, 'inputs', attemptId)
    expect(read.args[read.args.indexOf('-C') + 1]).toBe(root)
    expect(read.args).not.toContain('--output-schema')
    expect(read.args).toContain('allow_login_shell=false')
    // The home folder (with every credential in it) and the data outside it are hidden; the
    // workspace stays readable as the more specific rule.
    const hidden = await workflowCodexHiddenPaths(root)
    expect(hidden[0]).toBe(workflowHomeFolder())
    const table = [
      ...hidden.map((path) => `${JSON.stringify(path)}="deny"`),
      `${JSON.stringify(root)}="read"`
    ]
    expect(read.args).toContain(
      `permissions.${WORKFLOW_CODEX_PERMISSION_PROFILE}.filesystem={${table.join(',')}}`
    )
    expect(read.env.ZDOTDIR).toBe(join(attempt, 'shell'))
    expect(readdirSync(join(attempt, 'shell'))).toEqual([])
    expect(read.env.CODEX_HOME).toBe(join(attempt, 'codex-home'))
    expect(readlinkSync(join(attempt, 'codex-home', 'auth.json'))).toBe(join(account, 'auth.json'))
    expect(read.env.OPENAI_API_KEY).toBeUndefined()
    expect(readFileSync(join(attempt, 'instructions.md'), 'utf8')).toBe(
      workflowAgentInstructions('workspace-read', 'text')
    )
    expect(readdirSync(root)).toEqual([])

    const lunaDirectory = temporary('workflow-commands-')
    const lunaSeat = { ...seat, model: 'gpt-6-luna' }
    const lunaCommand = await workflowLaunchCommand(
      configured,
      { audit: { version: 5 } },
      lunaSeat,
      launchInput(),
      lunaDirectory,
      workflowLaunchMode({}, {})
    )
    const lunaAttempt = join(lunaDirectory, 'inputs', attemptId)
    expect(lunaCommand.program).toBe('codex')
    expect(lunaCommand.args[lunaCommand.args.indexOf('--model') + 1]).toBe('gpt-6-luna')
    expect(lunaCommand.args).toContain('model_reasoning_effort="high"')
    expect(lunaCommand.args).toContain('--output-schema')
    expect(lunaCommand.env.CODEX_HOME).toBe(join(lunaAttempt, 'codex-home'))
    expect(readlinkSync(join(lunaAttempt, 'codex-home', 'auth.json'))).toBe(
      join(account, 'auth.json')
    )
    expect(lunaCommand.env.OPENAI_API_KEY).toBeUndefined()

    const noveltyDirectory = temporary('workflow-commands-')
    await workflowLaunchCommand(
      configured,
      { audit: { version: 5 } },
      lunaSeat,
      launchInput({ schema: AUDIT_NOVELTY_SCHEMA }),
      noveltyDirectory,
      workflowLaunchMode({}, {})
    )
    const noveltySchema = JSON.parse(
      readFileSync(join(noveltyDirectory, 'inputs', attemptId, 'schema.json'), 'utf8')
    )
    const noveltyItem = noveltySchema.properties.findings.items
    expect(noveltyItem.required).toContain('contradictsFindingId')
    expect(noveltyItem.properties.contradictsFindingId).toEqual({
      anyOf: [{ type: 'string', pattern: '\\S', minLength: 1, maxLength: 200 }, { type: 'null' }]
    })
    expect(AUDIT_NOVELTY_SCHEMA.properties?.findings?.items?.required).not.toContain(
      'contradictsFindingId'
    )

    const legacyDirectory = temporary('workflow-commands-')
    const legacy = await workflowLaunchCommand(
      configured,
      {},
      seat,
      launchInput(),
      legacyDirectory,
      workflowLaunchMode({}, {})
    )
    const legacyAttempt = join(legacyDirectory, 'inputs', attemptId)
    expect(legacy.env.ZDOTDIR).toBeUndefined()
    expect(legacy.args).toEqual(
      buildWorkflowCodexArgs({
        model: 'gpt-5.6-sol',
        effort: 'high',
        schemaPath: join(legacyAttempt, 'schema.json'),
        instructionsPath: join(legacyAttempt, 'instructions.md')
      })
    )
    expect(readFileSync(join(legacyAttempt, 'instructions.md'), 'utf8')).toBe(
      WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS
    )
  })
})
