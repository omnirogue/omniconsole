import { randomUUID } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { DecisionProviderError } from '../../shared/structured-decisions'
import { decisionEnvironmentKilled, readBoundedConfiguration } from './decision-configuration'

const configurationSchema = z.object({ version: z.literal(1), enabled: z.boolean() }).strict()
let current: JevHostControl | undefined

export function jevEnvironmentDisabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.JEV_DECISIONS_DISABLED
  return (
    decisionEnvironmentKilled(environment) ||
    (value !== undefined && value !== '' && !['0', 'false'].includes(value.toLowerCase()))
  )
}

export class JevHostControl {
  readonly path: string
  private readonly pending = new Set<AbortController>()
  private epoch = 0

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'jev-control.json')
  }

  async status() {
    let enabled = true
    let configured = false
    let valid = true
    try {
      const parsed = configurationSchema.parse(
        JSON.parse(await readBoundedConfiguration(this.path))
      )
      enabled = parsed.enabled
      configured = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        enabled = false
        valid = false
      }
    }
    const environmentDisabled = jevEnvironmentDisabled()
    return {
      version: 1 as const,
      enabled,
      effective: enabled && valid && !environmentDisabled ? ('on' as const) : ('off' as const),
      configured,
      valid,
      environmentDisabled,
      configurationPath: this.path,
      scope: 'this-runtime-typesafe-provider',
      llmEscalation: 'unchanged-by-this-switch',
      pending: this.pending.size
    }
  }

  async setEnabled(enabled: boolean) {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, enabled }, null, 2), {
        flag: 'wx',
        mode: 0o600
      })
      await rename(temporary, this.path)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    this.epoch++
    for (const controller of this.pending) {
      controller.abort()
    }
    return this.status()
  }

  async run<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const epoch = this.epoch
    if ((await this.status()).effective === 'off') {
      throw new DecisionProviderError('disabled')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    this.pending.add(controller)
    try {
      if (signal.aborted || epoch !== this.epoch) {
        controller.abort()
      }
      if (controller.signal.aborted) {
        throw new DecisionProviderError('cancelled')
      }
      const result = await operation(controller.signal)
      if (controller.signal.aborted || epoch !== this.epoch) {
        throw new DecisionProviderError('cancelled')
      }
      if ((await this.status()).effective === 'off') {
        throw new DecisionProviderError('disabled')
      }
      if (controller.signal.aborted || epoch !== this.epoch) {
        throw new DecisionProviderError('cancelled')
      }
      return result
    } finally {
      signal.removeEventListener('abort', abort)
      this.pending.delete(controller)
    }
  }

  dispose(): void {
    this.epoch++
    for (const controller of this.pending) {
      controller.abort()
    }
    if (current === this) {
      current = undefined
    }
  }
}

export function installJevHostControl(userDataPath: string): JevHostControl {
  current?.dispose()
  current = new JevHostControl(userDataPath)
  return current
}

export function runWithJevHostControl<T>(
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (jevEnvironmentDisabled()) {
    return Promise.reject(new DecisionProviderError('disabled'))
  }
  return current ? current.run(signal, operation) : operation(signal)
}
