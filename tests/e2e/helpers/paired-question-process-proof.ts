import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { TestInfo } from '@stablyai/playwright-test'
import {
  processIdentityLiveness,
  recordProcessIdentity,
  waitForCondition,
  type RecordedProcessIdentity
} from './daemon-generation-processes'

type OwnedProcess = RecordedProcessIdentity & { role: string }

export function createPairedQuestionProcessProof(
  testInfo: TestInfo,
  registerAfterShutdown: (cleanup: () => Promise<void>) => void
): {
  record: (role: string, pid: number) => Promise<void>
  recordProfile: (role: string, userDataDir: string, mainPid: number) => Promise<void>
} {
  const processes: OwnedProcess[] = []
  const record = async (role: string, pid: number): Promise<void> => {
    const identity = await recordProcessIdentity(pid)
    if (
      !processes.some((entry) => entry.pid === pid && entry.startedAtMs === identity.startedAtMs)
    ) {
      processes.push({ role, ...identity })
    }
  }
  registerAfterShutdown(async () => {
    try {
      await waitForCondition(
        'this paired question fixture processes to exit',
        async () => {
          const live = await processIdentityLiveness(processes)
          return processes.every((entry) => !live.get(entry.pid))
        },
        15_000
      )
    } finally {
      const live = await processIdentityLiveness(processes)
      const proofPath = testInfo.outputPath('paired-question-teardown-proof.json')
      writeFileSync(
        proofPath,
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            processes: processes.map((entry) => ({
              ...entry,
              verdict: live.get(entry.pid) ? 'live' : 'exited'
            }))
          },
          null,
          2
        )
      )
      await testInfo.attach('paired-question-teardown-proof', {
        path: proofPath,
        contentType: 'application/json'
      })
    }
  })
  return {
    record,
    recordProfile: async (role, userDataDir, mainPid) => {
      await record(`${role}:main`, mainPid)
      const daemonDir = path.join(userDataDir, 'daemon')
      if (!existsSync(daemonDir)) {
        return
      }
      for (const file of readdirSync(daemonDir).filter((name) => name.endsWith('.pid'))) {
        const raw = readFileSync(path.join(daemonDir, file), 'utf8').trim()
        const parsed: unknown = JSON.parse(raw)
        const pid = typeof parsed === 'number' ? parsed : (parsed as { pid?: number })?.pid
        if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) {
          throw new Error(`Invalid isolated ${role} daemon pid record`)
        }
        await record(`${role}:daemon:${file}`, pid)
      }
    }
  }
}
