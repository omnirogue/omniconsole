const availableRuntimes = new WeakSet<object>()

/** Advertise optional host features only after their runtime implementation is installed. */
export function setStructuredDecisionAvailability(runtime: object, available: boolean): void {
  if (available) {
    availableRuntimes.add(runtime)
  } else {
    availableRuntimes.delete(runtime)
  }
}

export function isStructuredDecisionAvailable(runtime: object): boolean {
  return availableRuntimes.has(runtime)
}
