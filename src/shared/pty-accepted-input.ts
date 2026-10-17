/** Acknowledged input is an optional relay RPC capability, not a stream opcode. */
export const PTY_ACCEPTED_INPUT_VERSION = 1

export type PtyAcceptedInputResult = { accepted: true; incarnationId: string } | { accepted: false }
