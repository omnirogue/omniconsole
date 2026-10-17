/**
 * The test computers' wiring: opening (and restarting) one on its own temporary registry, and the
 * port another Mac would reach it through, which can lose replies or go dark to model partitions.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_HOST_UNREACHABLE } from '../../shared/session-host-client'
import { testHostProcess } from '../session-host/session-host-test-fixture'
import { TestComputer } from './session-transfer-host-fixture'
import {
  inProcessSessionTransferHostPort,
  type SessionTransferHostPort
} from './session-transfer-host-port'

export async function testComputer(
  name: string,
  incarnation = `${name}-1`
): Promise<{ computer: TestComputer; dispose: () => void }> {
  const root = mkdtempSync(join(tmpdir(), `transfer-${name}-`))
  const computer = new TestComputer(name, root)
  const process = testHostProcess({ root: join(root, 'registry'), incarnation, executor: computer })
  computer.service = await process.service()
  return { computer, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

/** The same computer after its OmniConsole restarted (the old process is proven gone). */
export async function restartTestComputer(
  before: TestComputer,
  incarnation: string,
  dead: string
): Promise<TestComputer> {
  const computer = new TestComputer(before.name, before.root)
  for (const id of before.frozen) {
    computer.frozen.add(id)
  }
  computer.adoptTranscriptsOf(before)
  const process = testHostProcess({
    root: join(before.root, 'registry'),
    incarnation,
    executor: computer,
    dead: [dead]
  })
  computer.service = await process.service()
  return computer
}

type Faults = {
  /** The host cannot be reached at all. */
  down: boolean
  /** Actions whose next reply is lost after the host recorded it (once each). */
  dropReplyOf: Set<string>
  /** Actions after which the host goes dark (the reply is lost, and so is every later call). */
  downAfter: Set<string>
  /** Bundle chunk writes after which the host goes dark (a partition mid-transfer). */
  downAfterWrites: number | null
  /** Rewrites a bundle chunk the source hands out (a corrupting channel). */
  tamperRead: ((base64: string) => string) | null
  /** Loses the reply to the next chunk write after the host recorded it. */
  dropChunkWriteReply: boolean
}

/** How the orchestrating Mac reaches a test computer, as another computer would. */
export function testPort(
  computer: TestComputer,
  peer = 'paired:orchestrator'
): SessionTransferHostPort & { faults: Faults } {
  const port = inProcessSessionTransferHostPort(computer.service, {
    label: computer.name,
    authority: (origin) => ({ kind: 'remote', transport: 'paired-runtime', peer, origin })
  })
  const faults: Faults = {
    down: false,
    dropReplyOf: new Set(),
    downAfter: new Set(),
    downAfterWrites: null,
    tamperRead: null,
    dropChunkWriteReply: false
  }
  let writes = 0
  const lost = { status: 'refused' as const, refusal: SESSION_HOST_UNREACHABLE }
  const guard =
    <A extends unknown[], R>(
      call: (...args: A) => Promise<R>,
      action?: (...args: A) => string | undefined
    ) =>
    async (...args: A): Promise<R | typeof lost> => {
      if (faults.down) {
        return lost
      }
      const reply = await call(...args)
      const name = action?.(...args)
      if (name && faults.downAfter.delete(name)) {
        faults.down = true
      }
      if (faults.down || (name && faults.dropReplyOf.delete(name))) {
        return lost
      }
      return reply
    }
  return {
    ...port,
    faults,
    observe: guard(port.observe) as typeof port.observe,
    execute: guard(port.execute, (request) => request.action) as typeof port.execute,
    reserve: guard(port.reserve, (request) => `reserve:${request.action}`) as typeof port.reserve,
    release: guard(port.release, () => 'release') as typeof port.release,
    operation: guard(port.operation) as typeof port.operation,
    relocationBundleRead: guard(
      async (params: Parameters<typeof port.relocationBundleRead>[0]) => {
        const reply = await port.relocationBundleRead(params)
        return reply.status === 'ok' && faults.tamperRead
          ? { ...reply, base64: faults.tamperRead(reply.base64) }
          : reply
      },
      () => 'bundle-read'
    ) as typeof port.relocationBundleRead,
    relocationBundleWrite: guard(
      async (params: Parameters<typeof port.relocationBundleWrite>[0]) => {
        const reply = await port.relocationBundleWrite(params)
        writes += params.base64 ? 1 : 0
        if (faults.downAfterWrites !== null && writes >= faults.downAfterWrites) {
          faults.down = true
        }
        if (params.base64 && faults.dropChunkWriteReply) {
          faults.dropChunkWriteReply = false
          return lost
        }
        return reply
      },
      () => 'bundle-write'
    ) as typeof port.relocationBundleWrite
  }
}
