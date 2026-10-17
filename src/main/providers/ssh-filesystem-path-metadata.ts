import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import type { SftpFactory } from './ssh-filesystem-download'
import { lstatViaSftp } from './ssh-filesystem-provider-sftp'
import type { FileStat } from './types'

export async function getSshHomeDir(mux: SshChannelMultiplexer): Promise<string> {
  const result = (await mux.request('session.resolveHome', { path: '~' })) as {
    resolvedPath?: unknown
  }
  if (typeof result.resolvedPath !== 'string' || result.resolvedPath === '~') {
    throw new Error('Remote home directory is unavailable.')
  }
  return result.resolvedPath
}

export async function lstatSshPath(
  mux: SshChannelMultiplexer,
  createSftp: SftpFactory | undefined,
  filePath: string
): Promise<FileStat> {
  try {
    return (await mux.request('fs.lstat', { filePath })) as FileStat
  } catch (error) {
    if (!isMethodNotFoundError(error)) {
      throw error
    }
    if (!createSftp) {
      throw new Error('remote_lstat_unavailable')
    }
    const sftp = await createSftp()
    try {
      // Why: older relays need SFTP to preserve symlink identity for worktree checks.
      return await lstatViaSftp(sftp, filePath)
    } finally {
      sftp.end()
    }
  }
}
