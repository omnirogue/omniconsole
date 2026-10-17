import { describe, expect, it } from 'vitest'
import { resolveSessionOutcomeSourceActor } from './session-outcome-source-actor'

describe('resolveSessionOutcomeSourceActor', () => {
  it.each(['codex', 'claude', 'grok', 'custom-agent'])('does not invent a %s model', (agent) => {
    expect(resolveSessionOutcomeSourceActor({ agent })).toBeNull()
    expect(resolveSessionOutcomeSourceActor({ agent, launchArgs: ['--effort', 'high'] })).toBeNull()
    expect(resolveSessionOutcomeSourceActor({ agent, options: { effort: 'high' } })).toBeNull()
  })

  it.each([
    ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="high"'],
    ['--model=gpt-6-astra', '--reasoning-effort=high'],
    ['-mgpt-6-astra', '-cmodel_reasoning_effort=high'],
    ['-m=gpt-6-astra', '-c=model_reasoning_effort=high'],
    ['--config', 'model="gpt-6-astra"', '--config', "model_reasoning_effort='high'"],
    ['--config=model="gpt-6-astra"', '--config=model_reasoning_effort="high"']
  ])('reads tokenized Codex flags %j', (...launchArgs) => {
    expect(resolveSessionOutcomeSourceActor({ agent: 'codex', launchArgs })).toEqual({
      agent: 'codex',
      model: 'gpt-6-astra',
      effort: 'high'
    })
  })

  it.each([
    { agent: 'claude', launchArgs: ['--model', 'claude-opus-5[1m]', '--effort', 'max'] },
    { agent: 'grok', launchArgs: ['-m', 'grok-4.6', '--reasoning-effort', 'max'] },
    { agent: 'custom-agent', launchArgs: ['--model=custom-model', '--effort=max'] }
  ])('reads explicit model and effort for $agent', ({ agent, launchArgs }) => {
    expect(resolveSessionOutcomeSourceActor({ agent, launchArgs })).toEqual({
      agent,
      model:
        agent === 'claude' ? 'claude-opus-5[1m]' : agent === 'grok' ? 'grok-4.6' : 'custom-model',
      effort: 'max'
    })
  })

  it('does not guess unknown providers’ short flag meanings', () => {
    expect(
      resolveSessionOutcomeSourceActor({ agent: 'custom-agent', launchArgs: ['-mode', 'focused'] })
    ).toBeNull()
  })

  it('ignores prompt tokens after the argument terminator and unrelated config', () => {
    expect(
      resolveSessionOutcomeSourceActor({
        agent: 'codex',
        launchArgs: ['-c', 'mcp_servers.example.token="secret"', '--', '--model', 'prompt-model']
      })
    ).toBeNull()
    expect(
      resolveSessionOutcomeSourceActor({
        agent: 'codex',
        launchArgs: ['-m', 'source-model', '--', '--model', 'prompt-model', '--effort', 'high']
      })
    ).toEqual({ agent: 'codex', model: 'source-model' })
  })

  it('uses the last explicit assignment and applied options over launch values', () => {
    const launchArgs = ['-m', 'first-model', '--model', 'last-model', '--effort', 'low']
    expect(resolveSessionOutcomeSourceActor({ agent: 'codex', launchArgs })).toEqual({
      agent: 'codex',
      model: 'last-model',
      effort: 'low'
    })
    expect(
      resolveSessionOutcomeSourceActor({
        agent: 'codex',
        launchArgs,
        options: { model: 'applied-model', effort: 'high' }
      })
    ).toEqual({ agent: 'codex', model: 'applied-model', effort: 'high' })
  })

  it('uses observed lifecycle model without carrying another model’s launch effort', () => {
    expect(
      resolveSessionOutcomeSourceActor({
        agent: 'grok',
        observedModel: 'observed-model',
        launchArgs: ['--model', 'launch-model', '--effort', 'high']
      })
    ).toEqual({ agent: 'grok', model: 'observed-model' })
  })

  it('keeps explicit effort when the model is unchanged or discovered after launch', () => {
    for (const launchArgs of [
      ['--effort', 'high'],
      ['--model', 'observed-model', '--effort', 'high']
    ]) {
      expect(
        resolveSessionOutcomeSourceActor({
          agent: 'grok',
          observedModel: 'observed-model',
          launchArgs
        })
      ).toEqual({ agent: 'grok', model: 'observed-model', effort: 'high' })
    }
  })

  it('uses the latest Codex turn context over lifecycle and launch metadata', () => {
    expect(
      resolveSessionOutcomeSourceActor({
        agent: 'codex',
        observedModel: 'lifecycle-model',
        options: { model: 'applied-model', effort: 'low' },
        launchArgs: ['-m', 'launch-model'],
        transcriptRecords: [
          { type: 'turn_context', payload: { model: 'earlier-model', effort: 'high' } },
          { type: 'turn_context', payload: { model: 'latest-model', reasoning_effort: 'xhigh' } },
          { type: 'response_item', payload: { model: 'irrelevant-content-model' } }
        ]
      })
    ).toEqual({ agent: 'codex', model: 'latest-model', effort: 'xhigh' })
  })

  it('does not carry an earlier transcript effort across a model switch', () => {
    expect(
      resolveSessionOutcomeSourceActor({
        agent: 'codex',
        transcriptRecords: [
          { type: 'turn_context', payload: { model: 'earlier-model', effort: 'high' } },
          { type: 'turn_context', payload: { model: 'latest-model' } }
        ]
      })
    ).toEqual({ agent: 'codex', model: 'latest-model' })
  })

  it('takes Claude model metadata only from assistant messages and skips synthetic errors', () => {
    expect(
      resolveSessionOutcomeSourceActor({
        agent: 'claude',
        launchArgs: ['--model', 'launch-model', '--effort', 'low'],
        transcriptRecords: [
          { type: 'assistant', message: { model: 'earlier-model' } },
          { type: 'assistant', message: { model: 'claude-opus-5', effort: 'max' } },
          { type: 'assistant', message: { model: '<synthetic>' } },
          { type: 'user', message: { model: 'quoted-model' } },
          { type: 'turn_context', payload: { model: 'other-provider-model' } }
        ]
      })
    ).toEqual({ agent: 'claude', model: 'claude-opus-5', effort: 'max' })
  })

  it('ignores malformed records and does not copy arbitrary fields', () => {
    expect(
      resolveSessionOutcomeSourceActor({
        agent: 'codex',
        observedModel: 'source-model',
        options: { token: 'private', model: ' ', effort: '' },
        transcriptRecords: [
          null,
          [],
          'not a record',
          { type: 'turn_context', payload: { model: 3 } }
        ]
      })
    ).toEqual({ agent: 'codex', model: 'source-model' })
  })

  it.each(['', ' ', '--effort', 'model\nother', 'x'.repeat(257)])(
    'does not treat invalid model %j as source evidence',
    (model) => {
      expect(resolveSessionOutcomeSourceActor({ agent: 'codex', options: { model } })).toBeNull()
    }
  )
})
