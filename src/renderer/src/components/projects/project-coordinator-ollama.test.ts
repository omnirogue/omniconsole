import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ reviewed: vi.fn(), toast: vi.fn() }))
vi.mock(
  '@/components/sidebar/session-folders/new-conversation/local-ollama/reviewed-local-ollama-launch',
  () => ({ reviewedLocalOllamaLaunch: mocks.reviewed })
)
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))

import { coordinatorOllamaTag, startOllamaCoordinator } from './project-coordinator-ollama'

const args = {
  folder: { id: 'f', name: 'Ads' },
  worktreeId: 'wt-1',
  tag: 'qwen',
  templateId: 'coordinator',
  onLaunched: vi.fn(),
  onReviewChange: vi.fn()
}

beforeEach(() => {
  mocks.reviewed.mockReset()
  mocks.toast.mockReset()
})

it('reads Local Ollama only from OpenCode with an ollama/<tag> model', () => {
  expect(coordinatorOllamaTag({ agent: 'opencode', model: 'ollama/qwen3-coder:30b' })).toBe(
    'qwen3-coder:30b'
  )
  expect(coordinatorOllamaTag({ agent: 'opencode', model: 'anthropic/x' })).toBeNull()
  expect(coordinatorOllamaTag({ agent: 'claude', model: 'ollama/qwen' })).toBeNull()
})

it('starts the chat through the reviewed Local Ollama launch', () => {
  startOllamaCoordinator({ ...args, local: true })
  expect(mocks.reviewed).toHaveBeenCalledWith(expect.objectContaining({ tag: 'qwen' }))
})

it('refuses another computer, since Ollama is reached only from this one', () => {
  startOllamaCoordinator({ ...args, local: false })
  expect(mocks.reviewed).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenCalled()
})
