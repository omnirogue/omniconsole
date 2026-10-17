import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { WorkflowAgentAccess } from '../../../shared/workflow-agent-instructions'
import { workflowAgentInstructions } from '../../../shared/workflow-agent-instructions'
import {
  buildWorkflowClaudeStreamArgs,
  WORKFLOW_CLAUDE_STREAM_ENVIRONMENT
} from '../../../shared/workflow-claude-command'
import { buildWorkflowCodexStreamArgs } from '../../../shared/workflow-codex-command'
import {
  buildWorkflowGeminiArgs,
  buildWorkflowGeminiSystemSettings,
  WORKFLOW_GEMINI_ADMIN_POLICY
} from '../../../shared/workflow-gemini-command'
import {
  buildWorkflowGrokStreamArgs,
  workflowGrokEnvironment,
  workflowGrokStreamProfile
} from '../../../shared/workflow-grok-command'
import type { GraphCall } from './graph/graph-plan-types'
import { drive } from './graph/graph-test-harness'
import { anyGraphAnswer, webResearch } from './graph/graph-web-test-fixtures'
import { WEB_RULES } from './graph/graph-web-types'
import { workflowLaunchMode } from './local-workflow-provider-commands'
import { OPENROUTER_WORKER_SCRIPT } from './workflow-openrouter-worker'

const ATTEMPT = '00000000-0000-4000-8000-000000000000'
const URL = 'https://a.example/one'

/** Everything a seat is launched with, built exactly as the launcher builds it for one call. */
function seatCommands(call: GraphCall, access: WorkflowAgentAccess) {
  const mode = workflowLaunchMode(access === 'workspace-read' ? { access } : {}, call)
  const schema = mode.output === 'schema' ? { schema: call.schema } : {}
  const root = mode.access === 'workspace-read' ? { workspaceRoot: '/workspace' } : {}
  return {
    claude: {
      args: buildWorkflowClaudeStreamArgs({
        model: 'claude-model',
        attemptId: ATTEMPT,
        access: mode.access,
        ...schema
      }),
      env: WORKFLOW_CLAUDE_STREAM_ENVIRONMENT
    },
    codex: {
      args: buildWorkflowCodexStreamArgs({
        model: 'codex-model',
        effort: 'medium',
        instructionsPath: '/attempt/instructions.md',
        ...(mode.output === 'schema' ? { schemaPath: '/attempt/schema.json' } : {}),
        ...root
      }),
      instructions: workflowAgentInstructions(mode.access, mode.output)
    },
    grok: {
      args: buildWorkflowGrokStreamArgs({
        model: 'grok-model',
        attemptId: ATTEMPT,
        profilePath: '/attempt/profile.md',
        promptPath: '/attempt/prompt.md',
        cwd: '/workspace',
        access: mode.access,
        ...schema
      }),
      profile: workflowGrokStreamProfile(mode.access, mode.output),
      env: workflowGrokEnvironment()
    },
    gemini: {
      args: buildWorkflowGeminiArgs({
        model: 'gemini-model',
        attemptId: ATTEMPT,
        adminPolicyPath: '/attempt/admin-policy.toml'
      }),
      settings: buildWorkflowGeminiSystemSettings({
        model: 'gemini-model',
        access: mode.access,
        ...schema
      }),
      policy: WORKFLOW_GEMINI_ADMIN_POLICY
    },
    openrouter: {
      args: ['-e', createHash('sha256').update(OPENROUTER_WORKER_SCRIPT).digest('hex')],
      mode: mode.access
    }
  }
}

/** The distinct launches a spec's agent calls need; the app's own calls never launch a seat. */
function launches(urls: string[], access: WorkflowAgentAccess): string[] {
  const spec = webResearch(urls)
  const plan = drive(spec, anyGraphAnswer(spec, { [URL]: { text: 'Words.' } }), {
    webRules: WEB_RULES
  })
  const agents = plan.calls.filter((call) => !call.web && !call.jev && !call.screen)
  return [...new Set(agents.map((call) => JSON.stringify(seatCommands(call, access))))].sort()
}

describe('a spec that reads the web gives no seat a new tool', () => {
  it.each<WorkflowAgentAccess>(['frozen', 'workspace-read'])(
    'launches every seat exactly as without pages (%s)',
    (access) => {
      const reading = launches([URL], access)
      expect(reading).toEqual(launches([], access))
      expect(reading.map((entry) => JSON.parse(entry) as unknown)).toMatchSnapshot()
      const all = reading.join('\n')
      expect(all).not.toMatch(/WebFetch|WebSearch|web_search=\\"(live|cached)\\"/)
      for (const entry of reading.map(
        (line) => JSON.parse(line) as ReturnType<typeof seatCommands>
      )) {
        expect(entry.codex.args).toContain('web_search="disabled"')
        expect(entry.grok.args).toContain('--disable-web-search')
        expect(entry.gemini.policy).toContain('"web_fetch"')
        expect(entry.gemini.policy).toContain('"google_web_search"')
        const tools = entry.claude.args[entry.claude.args.indexOf('--tools') + 1]
        expect(tools).toBe(access === 'workspace-read' ? 'Read,Grep,Glob' : '')
      }
    }
  )
})
