/** Auth refresh is inside the deadline too; a cancelled request never starts a late post. */
export async function withinRoutineSlackDeadline<T>(
  action: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('Slack request timed out after 10 seconds.'))
    }, 10_000)
    timer.unref?.()
  })
  try {
    return await Promise.race([action(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}
