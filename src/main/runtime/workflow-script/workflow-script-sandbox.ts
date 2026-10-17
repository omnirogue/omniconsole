import vm from 'node:vm'
import { LINE_END, parseWorkflowMetaLiteral } from './workflow-script-meta-literal'
import type {
  WorkflowScriptMeta,
  WorkflowScriptPhaseMeta
} from '../../../shared/workflow-script-types'

export class WorkflowScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowScriptError'
  }
}

const META_HEAD = /export\s+const\s+meta\s*=\s*/

/** The `{...}` after `export const meta =`, found by brace matching that respects strings. */
export function extractWorkflowScriptMetaSource(source: string): string | null {
  const head = META_HEAD.exec(source)
  if (!head) {
    return null
  }
  let start = head.index + head[0].length
  // Whitespace and comments may sit between `meta =` and the brace.
  for (;;) {
    while (start < source.length && /\s/.test(source[start]!)) {
      start += 1
    }
    if (source.startsWith('//', start)) {
      const end = source.slice(start).search(LINE_END)
      start = end === -1 ? source.length : start + end + 1
    } else if (source.startsWith('/*', start)) {
      const end = source.indexOf('*/', start + 2)
      start = end === -1 ? source.length : end + 2
    } else {
      break
    }
  }
  if (source[start] !== '{') {
    return null
  }
  let depth = 0
  let quote: string | null = null
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    // Comments may hold apostrophes or braces; they are not part of the literal's structure.
    if (char === '/' && source[index + 1] === '/') {
      const end = source.slice(index).search(LINE_END)
      index = end === -1 ? source.length : index + end
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 1
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(start, index + 1)
      }
    }
  }
  return null
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkflowScriptError(`meta.${what} must be a non-empty string`)
  }
  return value.trim()
}

function phase(value: unknown, index: number): WorkflowScriptPhaseMeta {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  if (!raw) {
    throw new WorkflowScriptError(`meta.phases[${index}] must be an object with a title`)
  }
  return {
    title: text(raw.title, `phases[${index}].title`),
    ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
    ...(typeof raw.model === 'string' ? { model: raw.model } : {})
  }
}

/**
 * The script's `meta`, parsed as a pure literal. Why a literal and not the script: the views
 * read meta before anything runs, and a literal that is only parsed cannot do anything.
 */
export function readWorkflowScriptMeta(source: string): WorkflowScriptMeta {
  const literal = extractWorkflowScriptMetaSource(source)
  if (!literal) {
    throw new WorkflowScriptError('no `export const meta = {...}` literal found')
  }
  let raw: unknown
  try {
    // Parsed as data, never evaluated: this path is reachable from the CLI and any session.
    raw = parseWorkflowMetaLiteral(literal)
  } catch (cause) {
    throw new WorkflowScriptError(
      `meta is not a pure literal: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (!record) {
    throw new WorkflowScriptError('meta must be an object literal')
  }
  const name = text(record.name, 'name')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new WorkflowScriptError('meta.name must be lowercase letters, digits and dashes')
  }
  const description = text(record.description, 'description')
  const phases = Array.isArray(record.phases) ? record.phases.map(phase) : []
  return {
    name,
    description,
    ...(typeof record.whenToUse === 'string' ? { whenToUse: record.whenToUse } : {}),
    phases
  }
}

/** The script body as an async function body: `export const meta` becomes a plain const. */
export function workflowScriptBody(source: string): string {
  return source.replace(/^\s*export\s+const\s+meta\s*=/m, 'const meta =')
}

export type WorkflowScriptGlobals = {
  agent: (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>
  parallel: (thunks: unknown) => Promise<unknown[]>
  pipeline: (items: unknown, ...stages: unknown[]) => Promise<unknown[]>
  log: (message: unknown) => void
  phase: (title: unknown) => void
  workflow: () => Promise<never>
  args: unknown
  budget: { total: number | null; spent: () => number; remaining: () => number }
}

// Why a prelude and not host proxies: the realm's own Date and Math are the ones the script
// sees; wrapping them inside the realm keeps `instanceof` and prototype chains intact.
const PRELUDE = `
  (() => {
    const forbid = __forbid;
    globalThis.Date = new Proxy(Date, {
      construct(T, a) { if (!a.length) forbid('new Date()'); return new T(...a) },
      get(T, p) { if (p === 'now') return () => forbid('Date.now()'); return Reflect.get(T, p) }
    });
    globalThis.Math = new Proxy(Math, {
      get(M, p) { if (p === 'random') return () => forbid('Math.random()'); return Reflect.get(M, p) }
    });
  })();
  delete globalThis.__forbid;
`

/**
 * Runs the script in its own realm with only the five primitives, `args` and `budget`;
 * no `require`, `process`, `fetch` or filesystem. The clock and randomness throw because
 * a script that reads them cannot be resumed from its journal.
 */
export function startWorkflowScript(
  source: string,
  globals: WorkflowScriptGlobals,
  timeoutMs: number
): Promise<unknown> {
  const context = vm.createContext({
    ...globals,
    __forbid: (what: string) => {
      throw new WorkflowScriptError(
        `${what} is unavailable in workflow scripts (it would break resume)`
      )
    }
  })
  try {
    vm.runInContext(PRELUDE, context, { timeout: 100 })
    const compiled = new vm.Script(`(async () => {\n${workflowScriptBody(source)}\n})()`, {
      filename: 'workflow-script.js'
    })
    return Promise.resolve(compiled.runInContext(context, { timeout: timeoutMs }))
  } catch (cause) {
    return Promise.reject(
      cause instanceof WorkflowScriptError
        ? cause
        : new WorkflowScriptError(
            `syntax error: ${cause instanceof Error ? cause.message : String(cause)}`
          )
    )
  }
}
