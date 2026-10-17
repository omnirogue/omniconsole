/**
 * Codex's native layout for relocation: one dated rollout, `<CODEX_HOME>/sessions/YYYY/MM/DD/
 * rollout-<stamp>-<id>.jsonl`, named in the bundle by that same `sessions/…` path so the
 * destination files it under its own home. Only uncompressed rollouts are a tested format.
 */

import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { prepareCodexSessionResume } from '../codex/codex-session-resume-preparation'
import { refuseRelocation } from './relocation-bundle-files'
import {
  checkJsonlTranscript,
  checkRelocationSessionId,
  type RelocationProviderAdapter
} from './relocation-provider-adapter'

const ROLLOUT_TAIL =
  /(?:^|[\\/])sessions[\\/](\d{4})[\\/](\d{2})[\\/](\d{2})[\\/](rollout-[^\\/:]+\.jsonl)$/

function rolloutPath(sessionId: string, file: string): boolean {
  return file.endsWith(`-${sessionId}.jsonl`)
}

export const CODEX_RELOCATION_ADAPTER: RelocationProviderAdapter = {
  provider: 'codex',

  async checkTranscript(transcriptPath, sessionId) {
    return await checkJsonlTranscript(
      transcriptPath,
      'Codex',
      (record, index) => {
        const payload = record.payload as { id?: unknown } | undefined
        return index === 0 && record.type === 'session_meta' && payload?.id === sessionId
      },
      (record) =>
        record.type === 'session_meta'
          ? (record.payload as { cli_version?: unknown } | undefined)?.cli_version
          : undefined
    )
  },

  exportFiles({ sessionId, transcriptPath }) {
    checkRelocationSessionId(sessionId)
    const match = ROLLOUT_TAIL.exec(transcriptPath)
    if (!isAbsolute(transcriptPath) || !match || !rolloutPath(sessionId, match[4]!)) {
      throw refuseRelocation(
        'unsupported-capability',
        transcriptPath.endsWith('.zst')
          ? 'That Codex conversation is stored compressed, a format this build has not tested for relocation. Nothing was moved.'
          : "That Codex rollout is not in Codex's dated sessions layout this build has tested. Nothing was moved."
      )
    }
    const [, year, month, day, file] = match
    return [{ path: `sessions/${year}/${month}/${day}/${file}`, absolute: transcriptPath }]
  },

  importPlan(manifest, place) {
    const sessionId = manifest.providerSessionId
    checkRelocationSessionId(sessionId)
    const only = manifest.files.length === 1 ? manifest.files[0]! : null
    const match = only
      ? /^sessions\/\d{4}\/\d{2}\/\d{2}\/(rollout-[^/:]+\.jsonl)$/.exec(only.path)
      : null
    if (!only || !match || !rolloutPath(sessionId, match[1]!)) {
      throw refuseRelocation(
        'invalid-request',
        `A Codex relocation carries exactly the rollout of conversation ${sessionId}. Nothing was staged.`
      )
    }
    const transcriptPath = join(place.providerRoot, ...only.path.split('/'))
    return { transcriptPath, files: [{ path: only.path, absolute: transcriptPath }] }
  },

  async resumeIdentity(plan, manifest, place) {
    const sessionId = manifest.providerSessionId
    // Why only the destination home: a same-id rollout under another account must never be picked.
    const preparation = await prepareCodexSessionResume({
      sessionId,
      transcriptPath: plan.transcriptPath,
      trustedCodexHomes: [place.providerRoot],
      getSelectedAccountCodexHome: () => null,
      systemCodexHomePath: null,
      sharedRuntimeCodexHomePath: null,
      resolveVerifiedResumeHome: async (source) => source.homePath
    }).catch(() => null)
    if (
      preparation?.outcome !== 'resume' ||
      resolve(preparation.codexHomePath) !== resolve(place.providerRoot) ||
      basename(dirname(dirname(dirname(dirname(plan.transcriptPath))))) !== 'sessions'
    ) {
      throw refuseRelocation(
        'not-eligible',
        `Codex would start a fresh conversation instead of resuming ${sessionId} from the staged rollout, and relocation never does that. Nothing was resumed.`
      )
    }
    return {
      agent: 'codex',
      sessionId,
      transcriptPath: plan.transcriptPath,
      providerRoot: preparation.codexHomePath
    }
  }
}
