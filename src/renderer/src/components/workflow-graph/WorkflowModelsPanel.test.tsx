// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WORKFLOW_ROUTES, type WorkflowSpec } from '../../../../shared/workflow-graph'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { DEFAULT_WORKFLOW_MODEL_TIERS } from '../../../../shared/workflow-model-tiers'
import { WorkflowModelsPanel } from './WorkflowModelsPanel'
import { useWorkflowModelTiers } from './use-workflow-model-tiers'
import { workflowModelDefaults, type WorkflowModelSource } from './workflow-model-sources'

const client = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  models: vi.fn(),
  tiers: vi.fn(),
  saveTiers: vi.fn()
}))
const planModels = vi.hoisted(() => vi.fn())
vi.mock('@/lib/workflow-model-client', () => ({ workflowModelClient: client }))
vi.mock('./use-workflow-compile', () => ({
  useWorkflowCompile: () => ({ planModels, compiling: false, cancel: vi.fn() })
}))

const sources: WorkflowModelSource[] = [
  {
    route: 'claude',
    models: [
      { id: 'opus', label: 'Opus', isDefault: true },
      { id: 'sonnet', label: 'Sonnet', isDefault: false },
      { id: 'haiku', label: 'Haiku', isDefault: false },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5', isDefault: false }
    ]
  },
  {
    route: 'codex',
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', isDefault: true },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', isDefault: false },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', isDefault: false }
    ]
  },
  {
    route: 'gemini',
    models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', isDefault: true }]
  },
  { route: 'openrouter', models: [] },
  {
    route: 'ollama',
    models: [{ id: 'qwen3:8b', label: 'qwen3:8b', isDefault: false, note: '5.2 GB' }]
  }
]
const available = WORKFLOW_ROUTES.filter((route) =>
  sources.some((source) => source.route === route)
)
const start = normalizeWorkflowSpec(
  {
    steps: [
      {
        id: 'find',
        kind: 'do',
        title: 'Find',
        agents: [{ route: 'claude' }, { route: 'codex' }],
        inputs: []
      },
      {
        id: 'verify',
        kind: 'review',
        title: 'Verify',
        agents: [{ route: 'codex' }],
        inputs: ['find']
      },
      {
        id: 'report',
        kind: 'synthesize',
        title: 'Report',
        agents: [{ route: 'claude' }],
        inputs: ['find', 'verify']
      }
    ]
  },
  available
)
const price = { contextLength: 1000, tools: true, structuredOutputs: true }

let latest: WorkflowSpec
function Harness() {
  const [spec, setSpec] = useState(start)
  latest = spec
  const tierState = useWorkflowModelTiers()
  return (
    <WorkflowModelsPanel
      worktreeId="wt"
      spec={spec}
      available={available}
      sources={sources}
      defaults={workflowModelDefaults(sources)}
      tierState={tierState}
      onChange={setSpec}
    />
  )
}
const models = (id: string) =>
  latest.steps
    .find((step) => step.id === id)!
    .agents.map((agent) => `${agent.route}:${agent.model ?? ''}`)

beforeEach(() => {
  client.tiers.mockResolvedValue({ tiers: DEFAULT_WORKFLOW_MODEL_TIERS, customized: false })
  client.saveTiers.mockImplementation(async (tiers) => ({
    tiers: tiers ?? DEFAULT_WORKFLOW_MODEL_TIERS,
    customized: !!tiers
  }))
  client.list.mockResolvedValue({ presets: [] })
  client.models.mockResolvedValue({
    models: [
      {
        ...price,
        id: 'qwen/qwen3.8-27b:free',
        name: 'Qwen3.8 27B (free)',
        promptPrice: 0,
        completionPrice: 0
      },
      {
        ...price,
        id: 'deepseek/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        promptPrice: 2.2e-8,
        completionPrice: 1.28e-6
      },
      {
        ...price,
        id: 'anthropic/claude-opus',
        name: 'Claude Opus',
        promptPrice: 5e-6,
        completionPrice: 2.5e-5
      }
    ]
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('lists every step with each agent model and its logo', () => {
  render(<Harness />)
  for (const title of ['Find', 'Verify', 'Report']) {
    expect(screen.getByText(title)).toBeInTheDocument()
  }
  const find = screen.getByText('Find').closest('li')!
  expect(within(find).getByRole('button', { name: 'Change model: Opus' })).toBeInTheDocument()
  expect(
    within(find).getByRole('button', { name: 'Change model: GPT-5.6 Sol' })
  ).toBeInTheDocument()
  // Every model button carries a logo (an inline mark or a bundled icon).
  for (const button of within(find).getAllByRole('button', { name: /^Change model/ })) {
    expect(button.querySelector('svg, img')).not.toBeNull()
  }
})

it('puts a tier on every step, or on one, and lights the tier a step is on', () => {
  render(<Harness />)
  const all = screen.getByRole('group', { name: 'Tier for every step' })
  fireEvent.click(within(all).getByRole('button', { name: 'Cheap' }))
  expect(models('find')).toEqual(['claude:claude-haiku-5-5', 'codex:gpt-6-luna'])
  expect(models('verify')).toEqual(['claude:claude-haiku-5-5'])
  expect(within(all).getByRole('button', { name: 'Cheap' })).toHaveAttribute('aria-pressed', 'true')
  const report = screen.getByRole('group', { name: 'Tier for Report' })
  fireEvent.click(within(report).getByRole('button', { name: 'Frontier' }))
  expect(models('report')).toEqual(['claude:'])
  expect(models('find')).toEqual(['claude:claude-haiku-5-5', 'codex:gpt-6-luna'])
  expect(within(report).getByRole('button', { name: 'Frontier' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  // Mixed tiers: the whole-workflow control lights none.
  expect(within(all).getByRole('button', { name: 'Cheap' })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
})

it('changes one agent to a free OpenRouter model through the price filter', async () => {
  render(<Harness />)
  const find = screen.getByText('Find').closest('li')!
  fireEvent.click(within(find).getByRole('button', { name: 'Change model: GPT-5.6 Sol' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Free' }))
  expect(await screen.findByRole('option', { name: /Qwen3.8 27B/ })).toBeInTheDocument()
  expect(
    screen.queryByRole('option', { name: /DeepSeek V4 Flash|Claude Opus/ })
  ).not.toBeInTheDocument()
  // $0.02 in but $1.28 out per 1M is low cost, not very low cost.
  fireEvent.click(screen.getByRole('button', { name: 'Very low cost' }))
  expect(screen.queryByRole('option', { name: /DeepSeek V4 Flash/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Low cost' }))
  expect(await screen.findByRole('option', { name: /DeepSeek V4 Flash/ })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /Claude Opus/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('option', { name: /Qwen3.8 27B/ }))
  expect(models('find')).toEqual(['claude:', 'openrouter:qwen/qwen3.8-27b:free'])
})

it('runs a combo of providers on one step, one agent per model', async () => {
  render(<Harness />)
  const find = screen.getByText('Find').closest('li')!
  fireEvent.click(within(find).getByRole('button', { name: 'Combo' }))
  // Opens with the step's models ticked; add a local and a low-cost one.
  fireEvent.click(await screen.findByRole('option', { name: /qwen3:8b/ }))
  fireEvent.click(await screen.findByRole('option', { name: /DeepSeek V4 Flash/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Run these 4' }))
  expect(models('find')).toEqual([
    'claude:',
    'codex:',
    'ollama:qwen3:8b',
    'openrouter:deepseek/deepseek-v4-flash'
  ])
  // A step that decides is offered no Google-family model.
  const verify = screen.getByText('Verify').closest('li')!
  fireEvent.click(within(verify).getByRole('button', { name: 'Combo' }))
  expect(await screen.findByRole('option', { name: /Sonnet/ })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /Gemini 3.8 Flash/ })).not.toBeInTheDocument()
})

it('sets models up from a description and reads back what changed', async () => {
  planModels.mockImplementation(async ({ spec }: { spec: WorkflowSpec }) => ({
    spec: {
      ...spec,
      steps: spec.steps.map((step) =>
        step.id === 'report' ? { ...step, agents: [{ route: 'claude', model: 'sonnet' }] } : step
      )
    },
    changed: ['report'],
    assumptions: ['Standard means Sonnet here.']
  }))
  render(<Harness />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Describe the models you want' }), {
    target: { value: 'standard model for the report' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
  await waitFor(() => expect(models('report')).toEqual(['claude:sonnet']))
  const asked = planModels.mock.calls[0][0]
  expect(asked.description).toBe('standard model for the report')
  expect(asked.context.catalog.ollama).toEqual(['qwen3:8b'])
  // Free first, then the cheapest; never a model that cannot be seated.
  expect(asked.context.catalog.openrouter.map((model: { id: string }) => model.id)).toEqual([
    'qwen/qwen3.8-27b:free',
    'deepseek/deepseek-v4-flash',
    'anthropic/claude-opus'
  ])
  expect(await screen.findByText('Report: Sonnet')).toBeInTheDocument()
  expect(screen.getByText('Assumed: Standard means Sonnet here.')).toBeInTheDocument()
})

it('lands a described plan on the workflow as it is then, keeping edits made while waiting', async () => {
  let answer: (value: unknown) => void = () => undefined
  planModels.mockImplementation(
    ({ spec }: { spec: WorkflowSpec }) =>
      new Promise((resolve) => {
        answer = () =>
          resolve({
            spec: {
              ...spec,
              steps: spec.steps.map((step) =>
                step.id === 'report'
                  ? { ...step, agents: [{ route: 'claude', model: 'sonnet' }] }
                  : step
              )
            },
            changed: ['report'],
            assumptions: []
          })
      })
  )
  render(<Harness />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Describe the models you want' }), {
    target: { value: 'standard for the report' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
  await waitFor(() => expect(planModels).toHaveBeenCalled())
  // While the agent thinks, the person puts Find on the Cheap tier.
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Tier for Find' })).getByRole('button', {
      name: 'Cheap'
    })
  )
  expect(models('find')).toEqual(['claude:claude-haiku-5-5', 'codex:gpt-6-luna'])
  answer(undefined)
  await waitFor(() => expect(models('report')).toEqual(['claude:sonnet']))
  expect(models('find')).toEqual(['claude:claude-haiku-5-5', 'codex:gpt-6-luna'])
})

it('adjusts what a tier means and saves it for every workflow', async () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Adjust tiers' }))
  const remove = await screen.findAllByRole('button', { name: 'Remove from Cheap' })
  fireEvent.click(remove[0])
  await waitFor(() =>
    expect(client.saveTiers).toHaveBeenCalledWith({
      ...DEFAULT_WORKFLOW_MODEL_TIERS,
      cheap: DEFAULT_WORKFLOW_MODEL_TIERS.cheap.slice(1)
    })
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Back to built-in tiers' }))
  await waitFor(() => expect(client.saveTiers).toHaveBeenLastCalledWith(null))
})
