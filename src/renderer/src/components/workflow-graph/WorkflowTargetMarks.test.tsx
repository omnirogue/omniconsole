// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LocalWorkflowEvidenceStatus } from '../../../../shared/local-workflow-view'
import { WorkflowTargetMarks } from './WorkflowTargetMarks'

let root: Root | null = null
let container: HTMLDivElement | null = null

function marks(status?: LocalWorkflowEvidenceStatus): string {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const target = {
    key: 'k',
    title: 'Off by one',
    detail: '',
    location: 'src/a.ts:3',
    severity: 'high' as const,
    repeats: 1,
    tally: 'unverified' as const,
    votes: [],
    ...(status ? { evidence: { status, line: 3 } } : {})
  }
  act(() => root?.render(<WorkflowTargetMarks target={target} />))
  return container.textContent ?? ''
}

describe('WorkflowTargetMarks', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  it.each([
    ['found', 'quote checked in the file'],
    ['moved', 'quote found elsewhere in the file'],
    ['missing', 'quote not found in the file'],
    ['unreadable', 'file could not be read']
  ] as const)('says what the quote check found: %s', (status, words) => {
    expect(marks(status)).toContain(words)
  })

  it('says nothing about a quote when there was none to check', () => {
    for (const status of ['not-code', 'unquoted', undefined] as const) {
      expect(marks(status)).not.toContain('quote')
      act(() => root?.unmount())
      container?.remove()
    }
  })
})
