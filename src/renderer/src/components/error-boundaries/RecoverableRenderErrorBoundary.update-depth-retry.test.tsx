// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RecoverableRenderErrorBoundary } from './RecoverableRenderErrorBoundary'
import {
  clearReactErrorBoundaryReportingForTest,
  REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT
} from '@/lib/react-error-boundary-reporting'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({}) }
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const REACT_185 =
  'Minified React error #185; visit https://react.dev/errors/185 for the full message.'

let failure: string | null = null
let renders = 0
let prompts = 0
const countPrompt = () => {
  prompts += 1
}
const crashReports = {
  recordRendererError: vi.fn(),
  dismiss: vi.fn()
}

function Flaky(): ReactElement {
  renders += 1
  if (failure) {
    throw new Error(failure)
  }
  return <span data-testid="content">ok</span>
}

describe('RecoverableRenderErrorBoundary after React #185', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    clearReactErrorBoundaryReportingForTest()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    crashReports.recordRendererError.mockReset()
    crashReports.recordRendererError.mockResolvedValue({
      ok: true,
      deduped: false,
      report: { id: 'report-1', status: 'pending' }
    })
    crashReports.dismiss.mockReset()
    crashReports.dismiss.mockResolvedValue({ ok: true })
    window.api = { crashReports } as unknown as typeof window.api
    window.addEventListener(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT, countPrompt)
    renders = 0
    prompts = 0
  })

  afterEach(() => {
    window.removeEventListener(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT, countPrompt)
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function mount(message: string): Promise<void> {
    failure = message
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <RecoverableRenderErrorBoundary
          boundaryId="terminal.workbench"
          surface="terminal-workbench"
        >
          <Flaky />
        </RecoverableRenderErrorBoundary>
      )
    })
  }

  const shown = () => container?.querySelector('[data-testid="content"]') !== null
  const advance = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms)
    })
  }

  it('remounts on its own once the burst has passed, keeping the report without a prompt', async () => {
    await mount(REACT_185)
    expect(shown()).toBe(false)
    failure = null
    await advance(1_500)
    expect(shown()).toBe(true)
    await advance(3_000)
    expect(crashReports.recordRendererError).toHaveBeenCalledTimes(1)
    expect(crashReports.dismiss).toHaveBeenCalledWith({ reportId: 'report-1' })
    expect(prompts).toBe(0)
  })

  it('gives up after two tries, so a loop that persists still shows its error', async () => {
    await mount(REACT_185)
    await advance(1_500)
    await advance(5_000)
    const settled = renders
    await advance(60_000)
    expect(renders).toBe(settled)
    expect(shown()).toBe(false)
    expect(container?.querySelector('[role="alert"]')).not.toBeNull()
    // The surface stayed broken, so the person is asked about it as before.
    expect(prompts).toBe(1)
    expect(crashReports.dismiss).not.toHaveBeenCalled()
  })

  it('never retries an unrelated render error by itself, and prompts for it at once', async () => {
    await mount('Cannot read properties of undefined')
    const settled = renders
    await advance(60_000)
    expect(renders).toBe(settled)
    expect(shown()).toBe(false)
    expect(prompts).toBe(1)
  })
})
