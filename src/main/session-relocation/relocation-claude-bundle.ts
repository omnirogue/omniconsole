/**
 * Claude's native layout for relocation: `<config>/projects/<encoded cwd>/<id>.jsonl` plus its
 * sibling `<id>/` artifacts (subagents, tool results), the same pair
 * `copyClaudeResumeTranscript` copies between account seats. The bundle names them relative to the
 * project folder, so the destination files them under the encoding of its own workspace path.
 */

import { lstatSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { SessionHostRelocationManifest } from '../../shared/session-host-payload-schema'
import { encodeClaudeProjectPath } from '../ai-vault/claude-project-dir-encoding'
import { claudeResumeConfigDir, selectClaudeResumeIdentity } from '../claude/claude-resume-identity'
import {
  listRelocationTree,
  refuseRelocation,
  type RelocationBundleFile
} from './relocation-bundle-files'
import {
  checkJsonlTranscript,
  checkRelocationSessionId,
  type RelocationProviderAdapter
} from './relocation-provider-adapter'

function projectFolder(transcriptPath: string, sessionId: string): string {
  const folder = dirname(transcriptPath)
  if (
    !isAbsolute(transcriptPath) ||
    basename(transcriptPath) !== `${sessionId}.jsonl` ||
    basename(dirname(folder)) !== 'projects'
  ) {
    throw refuseRelocation(
      'unsupported-capability',
      "That Claude transcript is not in Claude's projects layout this build has tested. Nothing was moved."
    )
  }
  return folder
}

function inLayout(path: string, sessionId: string): boolean {
  return path === `${sessionId}.jsonl` || path.startsWith(`${sessionId}/`)
}

export const CLAUDE_RELOCATION_ADAPTER: RelocationProviderAdapter = {
  provider: 'claude',

  async checkTranscript(transcriptPath, sessionId) {
    return await checkJsonlTranscript(
      transcriptPath,
      'Claude',
      (record) => record.sessionId === sessionId,
      (record) => record.version
    )
  },

  exportFiles({ sessionId, transcriptPath }) {
    checkRelocationSessionId(sessionId)
    const folder = projectFolder(transcriptPath, sessionId)
    const files: RelocationBundleFile[] = [{ path: `${sessionId}.jsonl`, absolute: transcriptPath }]
    const artifacts = join(folder, sessionId)
    if (lstatExists(artifacts)) {
      // Why lstat: a linked artifacts folder could lead outside the conversation.
      if (!lstatSync(artifacts).isDirectory()) {
        throw refuseRelocation(
          'not-eligible',
          `${sessionId} next to the transcript is not a plain folder. Nothing was moved.`
        )
      }
      files.push(...listRelocationTree(artifacts, sessionId))
    }
    return files
  },

  importPlan(manifest, place) {
    const sessionId = manifest.providerSessionId
    checkRelocationSessionId(sessionId)
    const folder = join(
      place.providerRoot,
      'projects',
      encodeClaudeProjectPath(place.workspacePath)
    )
    const outside = manifest.files.find((file) => !inLayout(file.path, sessionId))
    if (outside) {
      throw refuseRelocation(
        'invalid-request',
        `${outside.path} is not part of Claude conversation ${sessionId}. Nothing was staged.`
      )
    }
    const transcriptPath = join(folder, `${sessionId}.jsonl`)
    if (!manifest.files.some((file) => file.path === `${sessionId}.jsonl`)) {
      throw refuseRelocation(
        'invalid-request',
        `The bundle has no transcript for Claude conversation ${sessionId}. Nothing was staged.`
      )
    }
    return {
      transcriptPath,
      files: manifest.files.map((file) => ({
        path: file.path,
        absolute: join(folder, ...file.path.split('/'))
      }))
    }
  },

  async resumeIdentity(plan, manifest: SessionHostRelocationManifest, place) {
    const sessionId = manifest.providerSessionId
    // Why no verifiedFallback: relocation resumes this identity or nothing, never another one.
    const identity: AgentProviderSessionMetadata = {
      key: 'session_id',
      id: sessionId,
      transcriptPath: plan.transcriptPath
    }
    const selected = selectClaudeResumeIdentity(identity)
    const configDir = selected ? claudeResumeConfigDir(selected) : undefined
    if (
      !selected ||
      selected.id !== sessionId ||
      selected.transcriptPath !== plan.transcriptPath ||
      !configDir ||
      resolve(configDir) !== resolve(place.providerRoot)
    ) {
      throw refuseRelocation(
        'not-eligible',
        `Claude would not resume conversation ${sessionId} from the staged transcript, and relocation never starts a different one. Nothing was resumed.`
      )
    }
    return {
      agent: 'claude',
      sessionId,
      transcriptPath: plan.transcriptPath,
      providerRoot: configDir
    }
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
