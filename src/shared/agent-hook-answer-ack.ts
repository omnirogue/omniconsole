/**
 * The wire between the hook listener and the managed hook scripts for hook-first answers: a reply
 * carrying an answer starts with `omni-answer <item id> <nonce>`, which the script strips before
 * printing the JSON and then echoes to the acknowledgement path.
 */
export const HOOK_ANSWER_REPLY_PREFIX = 'omni-answer '
export const HOOK_ANSWER_ACK_PATHNAME = '/hook-answer-ack'
