import { describe, expect, it } from 'vitest'
import {
  applyAgentPermissionMode,
  BYPASS_ONLY_TUI_AGENT_ARGS,
  getTuiAgentArgsForPermissionMode,
  resolveAgentPermissionModeSummary,
  resolvePublishedTuiAgentPermissionMode,
  resolveTuiAgentPermissionMode,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV,
  type RestrictedTuiAgentPreset
} from './tui-agent-permissions'
import type { TuiAgent } from './tui-agent'

const RESTRICTED_VENDORS = [
  'claude',
  'codex',
  'grok',
  'gemini'
] as const satisfies readonly TuiAgent[]
const RESTRICTED_PRESETS = [
  'plan',
  'read-only',
  'approve'
] as const satisfies readonly RestrictedTuiAgentPreset[]

const EXPECTED_RESTRICTED_ARGS: Record<
  (typeof RESTRICTED_VENDORS)[number],
  Record<RestrictedTuiAgentPreset, string>
> = {
  claude: {
    plan: '--permission-mode plan',
    'read-only': '--permission-mode plan',
    approve: ''
  },
  codex: {
    plan: '',
    'read-only': '-s read-only -a never',
    approve: ''
  },
  grok: {
    plan: '--permission-mode plan',
    'read-only': '--permission-mode plan',
    approve: ''
  },
  gemini: {
    plan: '--approval-mode plan',
    'read-only': '--approval-mode plan',
    approve: ''
  }
}

function expectedResolvedPreset(
  vendor: (typeof RESTRICTED_VENDORS)[number],
  preset: RestrictedTuiAgentPreset
): 'plan' | 'read-only' | 'manual' {
  const flags = EXPECTED_RESTRICTED_ARGS[vendor][preset]
  if (!flags) {
    return 'manual'
  }
  if (preset === 'read-only' && flags === EXPECTED_RESTRICTED_ARGS[vendor].plan) {
    return 'plan'
  }
  return preset === 'approve' ? 'manual' : preset
}

describe('tui agent permissions', () => {
  it('recognizes the current default profile as yolo', () => {
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      })
    ).toBe('yolo')
  })

  it('recognizes an empty profile as manual', () => {
    expect(resolveAgentPermissionModeSummary({ agentDefaultArgs: {}, agentDefaultEnv: {} })).toBe(
      'manual'
    )
  })

  it('reports mixed when yolo and manual launches are both present', () => {
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: {
          ...YOLO_TUI_AGENT_ARGS,
          claude: ''
        },
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      })
    ).toBe('mixed')
  })

  it('preserves custom agent arguments when applying manual mode', () => {
    const result = applyAgentPermissionMode({
      mode: 'manual',
      agentDefaultArgs: {
        claude: '--dangerously-skip-permissions',
        codex: '--model gpt-5'
      },
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })

    expect(result.agentDefaultArgs.claude).toBe('')
    expect(result.agentDefaultArgs.codex).toBe('--model gpt-5')
    expect(result.agentDefaultEnv.goose).toEqual({})
  })

  it('reports mixed when custom arguments are present', () => {
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: {
          ...YOLO_TUI_AGENT_ARGS,
          codex: '--model gpt-5'
        },
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      })
    ).toBe('mixed')
  })

  it('resolves one Codex yolo launch as yolo', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'codex',
        agentArgs: YOLO_TUI_AGENT_ARGS.codex,
        agentEnv: {}
      })
    ).toBe('yolo')
  })

  it('resolves one empty Codex launch as manual', () => {
    expect(resolveTuiAgentPermissionMode({ agent: 'codex', agentArgs: '', agentEnv: {} })).toBe(
      'manual'
    )
  })

  it('resolves custom Codex permission arguments as mixed', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'codex',
        agentArgs: '--ask-for-approval on-request',
        agentEnv: {}
      })
    ).toBe('mixed')
  })

  it('resolves env-driven yolo launches', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'goose',
        agentArgs: '',
        agentEnv: YOLO_TUI_AGENT_ENV.goose
      })
    ).toBe('yolo')
  })

  it.each(
    RESTRICTED_VENDORS.flatMap((vendor) => RESTRICTED_PRESETS.map((preset) => ({ vendor, preset })))
  )('maps $vendor $preset to the vendor restricted flags', ({ vendor, preset }) => {
    expect(getTuiAgentArgsForPermissionMode(vendor, preset)).toBe(
      EXPECTED_RESTRICTED_ARGS[vendor][preset]
    )
  })

  it.each(
    RESTRICTED_VENDORS.flatMap((vendor) => RESTRICTED_PRESETS.map((preset) => ({ vendor, preset })))
  )('resolves $vendor $preset flags as the matching preset', ({ vendor, preset }) => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: vendor,
        agentArgs: EXPECTED_RESTRICTED_ARGS[vendor][preset],
        agentEnv: {}
      })
    ).toBe(expectedResolvedPreset(vendor, preset))
  })

  it('applies plan flags across managed agents and reports the plan preset', () => {
    const result = applyAgentPermissionMode({
      mode: 'plan',
      agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })

    expect(result.agentDefaultArgs.claude).toBe('--permission-mode plan')
    expect(result.agentDefaultArgs.codex).toBe('')
    expect(result.agentDefaultArgs.grok).toBe('--permission-mode plan')
    expect(result.agentDefaultArgs.gemini).toBe('--approval-mode plan')
    expect(result.agentDefaultEnv.goose).toEqual({})
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: result.agentDefaultArgs,
        agentDefaultEnv: result.agentDefaultEnv
      })
    ).toBe('plan')
  })

  it('applies read-only flags across managed agents and reports the read-only preset', () => {
    const result = applyAgentPermissionMode({
      mode: 'read-only',
      agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })

    expect(result.agentDefaultArgs.claude).toBe('--permission-mode plan')
    expect(result.agentDefaultArgs.codex).toBe('-s read-only -a never')
    expect(result.agentDefaultArgs.grok).toBe('--permission-mode plan')
    expect(result.agentDefaultArgs.gemini).toBe('--approval-mode plan')
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: result.agentDefaultArgs,
        agentDefaultEnv: result.agentDefaultEnv
      })
    ).toBe('read-only')
  })

  it('applies approve as no permission flags', () => {
    const result = applyAgentPermissionMode({
      mode: 'approve',
      agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })

    expect(result.agentDefaultArgs.claude).toBe('')
    expect(result.agentDefaultArgs.codex).toBe('')
    expect(result.agentDefaultArgs.grok).toBe('')
    expect(result.agentDefaultArgs.gemini).toBe('')
    expect(result.agentDefaultEnv.goose).toEqual({})
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: result.agentDefaultArgs,
        agentDefaultEnv: result.agentDefaultEnv
      })
    ).toBe('manual')
  })

  it('still reports mixed for an unknown permission mode string in launch args', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'claude',
        agentArgs: '--permission-mode totally-unknown',
        agentEnv: {}
      })
    ).toBe('mixed')
  })

  it('publishes a launch-config permission preset for terminal.list', () => {
    expect(
      resolvePublishedTuiAgentPermissionMode({
        agent: 'claude',
        launchConfig: { agentArgs: '--permission-mode plan', agentEnv: {} }
      })
    ).toBe('plan')
    expect(
      resolvePublishedTuiAgentPermissionMode({
        agent: 'codex',
        launchConfig: { agentArgs: '-s read-only -a never', agentEnv: {} }
      })
    ).toBe('read-only')
    expect(resolvePublishedTuiAgentPermissionMode({ agent: 'claude' })).toBeUndefined()
  })

  describe('OMP: --yolo is Bypass-only, never a default', () => {
    it('omp is absent from YOLO_TUI_AGENT_ARGS (which also backs DEFAULT_TUI_AGENT_ARGS)', () => {
      expect(YOLO_TUI_AGENT_ARGS.omp).toBeUndefined()
      expect('omp' in YOLO_TUI_AGENT_ARGS).toBe(false)
    })

    it('omp --yolo lives in BYPASS_ONLY_TUI_AGENT_ARGS instead', () => {
      expect(BYPASS_ONLY_TUI_AGENT_ARGS.omp).toBe('--yolo')
    })

    it('getTuiAgentArgsForPermissionMode falls back to the Bypass-only map for yolo mode', () => {
      expect(getTuiAgentArgsForPermissionMode('omp', 'yolo')).toBe('--yolo')
    })
  })
})
