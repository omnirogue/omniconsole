import { describe, expect, it } from 'vitest'
import { createOmpCatalogModel } from './agent-session-option-catalog-omp'
import { checkAgentLaunchPreferences } from './agent-launch-preference-check'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

const opus = 'openrouter/anthropic/claude-opus-5'
const gemini = 'openrouter/google/gemini-3.8-flash'
const plain = 'openrouter/example/plain'

describe('OMP discovered thinking ladders reach production launches', () => {
  it('emits --thinking for a discovered id via the production 2-arg check and no-catalog launch', () => {
    expect(checkAgentLaunchPreferences('omp', { model: opus, effort: 'max' })).toEqual({
      ok: true,
      preferences: { model: opus, effort: 'max' }
    })
    expect(
      resolveAgentLaunchCommand({
        agent: 'omp',
        cmdOverrides: {},
        platform: 'linux',
        shell: 'posix',
        sessionOptions: { model: opus, effort: 'max' }
      })
    ).toMatchObject({
      ok: true,
      command: `command omp '--model' '${opus}' '--thinking' 'max'`,
      appliedSessionOptions: { model: opus, effort: 'max' }
    })
  })

  it('inherits the CLI default without emitting a thinking flag when no effort is picked', () => {
    expect(checkAgentLaunchPreferences('omp', { model: opus })).toEqual({
      ok: true,
      preferences: { model: opus }
    })
    expect(
      resolveAgentLaunchCommand({
        agent: 'omp',
        cmdOverrides: {},
        platform: 'linux',
        shell: 'posix',
        sessionOptions: { model: opus }
      })
    ).toMatchObject({
      ok: true,
      command: `command omp '--model' '${opus}'`,
      appliedSessionOptions: { model: opus }
    })
  })

  it('exposes only the discovered ladder per model, and none for a non-reasoning model', () => {
    expect(
      createOmpCatalogModel({
        id: gemini,
        label: 'Gemini',
        reasoning: true,
        thinking: ['low', 'medium', 'high']
      }).options
    ).toMatchObject([
      {
        id: 'effort',
        kind: {
          type: 'select',
          choices: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]
        }
      }
    ])
    expect(
      createOmpCatalogModel({ id: plain, label: 'Plain', reasoning: false, thinking: null }).options
    ).toEqual([])
  })

  it('preserves CLI order and chooses a default present in the advertised ladder', () => {
    const model = createOmpCatalogModel({
      id: 'ordered',
      label: 'ordered',
      reasoning: true,
      thinking: ['max', 'low']
    })
    expect(model.options[0].kind).toEqual({
      type: 'select',
      choices: [
        { value: 'max', label: 'Max' },
        { value: 'low', label: 'Low' }
      ],
      defaultValue: 'max'
    })
  })

  it('prefers high when the advertised ladder has no medium', () => {
    const model = createOmpCatalogModel({
      id: 'no-medium',
      label: 'no-medium',
      reasoning: true,
      thinking: ['minimal', 'low', 'high', 'xhigh']
    })
    expect(model.options[0].kind).toMatchObject({ defaultValue: 'high' })
  })

  it.each([
    { reasoning: true, thinking: [] },
    { reasoning: true, thinking: null },
    { thinking: ['low', 'medium', 'high'] },
    { reasoning: false, thinking: ['low', 'medium', 'high'] }
  ])('does not invent thinking support for %j', (metadata) => {
    expect(createOmpCatalogModel({ id: 'plain', label: 'plain', ...metadata }).options).toEqual([])
  })
})
