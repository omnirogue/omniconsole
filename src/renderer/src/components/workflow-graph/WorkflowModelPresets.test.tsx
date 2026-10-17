// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { WorkflowModelPresets } from './WorkflowModelPresets'
import { WorkflowOpenRouterPicker } from './WorkflowOpenRouterPicker'

const client = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), models: vi.fn() }))
vi.mock('@/lib/workflow-model-client', () => ({ workflowModelClient: client }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
it('applies a saved rotation and reports unchanged judging steps', async () => {
  client.list.mockResolvedValue({
    presets: [
      { id: 'one', name: 'Google only', models: [{ route: 'openrouter', model: 'google/gemini' }] }
    ]
  })
  const spec = normalizeWorkflowSpec({
    steps: [
      { id: 'make', kind: 'do', agents: [{ route: 'claude' }], inputs: [] },
      { id: 'rank', kind: 'rank', agents: [{ route: 'codex' }], inputs: ['make'] }
    ]
  })
  const onChange = vi.fn()
  render(<WorkflowModelPresets spec={spec} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Models' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Google only' }))
  expect(onChange.mock.calls[0][0].steps[0].agents[0].model).toBe('google/gemini')
  expect(onChange.mock.calls[0][0].steps[1]).toEqual(spec.steps[1])
  expect(screen.getByRole('status')).toHaveTextContent('no eligible judge')
})
it('saves distinct current models under the entered name', async () => {
  client.list.mockResolvedValue({ presets: [] })
  client.save.mockResolvedValue({ presets: [] })
  const spec = normalizeWorkflowSpec({
    steps: [
      {
        id: 'make',
        kind: 'do',
        agents: [
          { route: 'openrouter', model: 'deepseek/chat' },
          { route: 'openrouter', model: 'deepseek/chat' }
        ],
        inputs: []
      }
    ]
  })
  render(<WorkflowModelPresets spec={spec} onChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Models' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save current as preset…' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save current as preset…' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Preset name' }), {
    target: { value: 'Cheap' }
  })
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
  await waitFor(() =>
    expect(client.save).toHaveBeenCalledWith({
      name: 'Cheap',
      models: [{ route: 'openrouter', model: 'deepseek/chat' }]
    })
  )
})
it('offers structured models from eligible families to judges', async () => {
  const model = {
    contextLength: 1000,
    promptPrice: 0.0000001,
    completionPrice: 0.0000002,
    tools: true,
    structuredOutputs: true
  }
  client.models.mockResolvedValue({
    models: [
      { ...model, id: 'deepseek/chat', name: 'DeepSeek' },
      { ...model, id: 'google/gemini', name: 'Google' },
      { ...model, id: 'unknown/claude', name: 'Unknown' },
      { ...model, id: 'qwen/plain', name: 'Plain', structuredOutputs: false }
    ]
  })
  const onChange = vi.fn()
  render(<WorkflowOpenRouterPicker judge onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose OpenRouter model' }))
  const option = await screen.findByRole('option', { name: /DeepSeek/ })
  expect(screen.queryByRole('option', { name: /Google|Unknown|Plain/ })).not.toBeInTheDocument()
  fireEvent.click(option)
  expect(onChange).toHaveBeenCalledWith('deepseek/chat')
})
