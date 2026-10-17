import { z } from 'zod'
import { sshOmpChatRequest } from '../../../../shared/ssh-native-chat'
import { requireSshFilesystemProvider } from '../../../providers/ssh-filesystem-dispatch'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority
} from '../../../ssh/ssh-provider-authority'
import { defineMethod } from '../core'

export const SSH_NATIVE_CHAT_READ = defineMethod({
  name: 'nativeChat.readSshOmpSession',
  params: sshOmpChatRequest.extend({ connectionId: z.string().min(1) }),
  handler: async ({ connectionId, ...params }, { signal }) => {
    try {
      const authority = getSshProviderAuthority(connectionId)
      const read = requireSshFilesystemProvider(connectionId).transcripts?.readOmpTail
      if (!read) {
        throw new Error(
          'omp_transcript_capability_unavailable: Update the SSH relay to read OMP Chat.'
        )
      }
      const result = await read(params, signal)
      signal?.throwIfAborted()
      if (!isCurrentSshProviderAuthority(authority)) {
        throw new Error('SSH transcript connection changed during lookup. Retry the read.')
      }
      return result
    } catch (error) {
      signal?.throwIfAborted()
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
})
