import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-environment'
import { EVOLVE_RUN_ID_PATTERN, type EvolveRunRecord } from '../../../shared/evolve-workflow'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'

/** Directory under userData holding one JSON file per Evolve run. */
export const EVOLVE_RUNS_DIRECTORY = 'evolve-runs'

type Logger = (message: string, detail?: unknown) => void

function defaultLogger(message: string, detail?: unknown): void {
  console.warn(`[evolve] ${message}`, detail ?? '')
}

function isRecordShape(value: unknown, id: string): value is EvolveRunRecord {
  const record = value as Partial<EvolveRunRecord> | null
  return (
    !!record &&
    record.id === id &&
    typeof record.state === 'string' &&
    typeof record.host === 'string' &&
    !!record.request &&
    !!record.placement &&
    Array.isArray(record.events)
  )
}

/** Every Evolve run this computer started, so a restart resumes following the ones still going. */
export class EvolveRunStore {
  private directoryReady = false

  constructor(
    private readonly directory: string | null,
    private readonly log: Logger = defaultLogger
  ) {}

  load(): EvolveRunRecord[] {
    if (!this.directory) {
      return []
    }
    let names: string[]
    try {
      names = readdirSync(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`Could not read ${this.directory}`, error)
      }
      return []
    }
    return names.flatMap((name) => {
      const id = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (!EVOLVE_RUN_ID_PATTERN.test(id)) {
        return []
      }
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(this.directory!, name), 'utf-8'))
        return isRecordShape(parsed, id) ? [parsed] : []
      } catch (error) {
        this.log(`Skipping unreadable run file ${name}`, error)
        return []
      }
    })
  }

  /** Written before this returns and throws on failure: a Start acts only on a recorded run. */
  persist(record: EvolveRunRecord): void {
    if (!EVOLVE_RUN_ID_PATTERN.test(record.id)) {
      throw new Error(`Refusing to write run ${record.id}: unexpected id`)
    }
    if (!this.directory) {
      return
    }
    if (!this.directoryReady) {
      mkdirSync(this.directory, { recursive: true })
      this.directoryReady = true
    }
    const path = join(this.directory, `${record.id}.json`)
    writeFileDurableSync(durableWriteTempPath(path), path, JSON.stringify(record), {
      strictDirectorySync: true
    })
  }

  /** Best effort: a later update is written again. */
  save(record: EvolveRunRecord): void {
    try {
      this.persist(record)
    } catch (error) {
      this.log(`Could not persist run ${record.id}`, error)
    }
  }
}

/** The desktop host's userData directory for runs; null where no app environment is installed. */
export function defaultEvolveRunDirectory(): string | null {
  if (!hasAppEnvironment()) {
    return null
  }
  try {
    return join(getAppEnvironment().getPath('userData'), EVOLVE_RUNS_DIRECTORY)
  } catch {
    return null
  }
}
