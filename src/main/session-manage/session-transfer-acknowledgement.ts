/** A matched turn must positively accept this exact transfer before any source is archived. */
export function transferAcknowledgement(id: string): string {
  return `Accepted transfer ${id}`
}

export function transferAcknowledgementInstruction(receipt: string): string {
  return `If you accept responsibility for this work, reply with only this exact line (no other text):\n${receipt}\nIf you cannot accept it, explain why without that line.`
}

export function requireTransferAcknowledgement(reply: string, receipt: string | undefined): void {
  if (!receipt || reply.trim() !== receipt) {
    throw new Error(`The target did not positively acknowledge this transfer. Its reply: ${reply}`)
  }
}
