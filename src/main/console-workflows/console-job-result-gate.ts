export class ConsoleJobResultGate {
  private readonly pending = new Map<string, Promise<unknown>>()

  run<T>(dispatchId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(dispatchId)
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(work)
    this.pending.set(dispatchId, result)
    void result
      .finally(() => {
        if (this.pending.get(dispatchId) === result) {
          this.pending.delete(dispatchId)
        }
      })
      .catch(() => undefined)
    return result
  }
}
