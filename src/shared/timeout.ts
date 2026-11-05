/**
 * `promise`, or a rejection with `message` after `ms`; the timer never outlives the race (a pending
 * timer would keep a short-lived process alive and fire after the answer came).
 */
export function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
