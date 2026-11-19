/**
 * Small async gates for mcp-on-demand.
 *
 * A limiter caps how many servers may be starting at once. The slot is handed
 * to the next waiter instead of being released and taken again, so two tasks
 * cannot both pass the check before either increments.
 *
 * A name lock runs work for one server in order. Enable and probe share it, so
 * they cannot start two processes for the same name.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

/**
 * @param {number} max
 * @returns {{ run<T>(task: () => Promise<T>): Promise<T> }}
 */
export function createLimiter(max) {
  const capacity = Number.isInteger(max) && max >= 1 ? max : 1
  let active = 0
  /** @type {Array<() => void>} */
  const waiting = []
  return {
    async run(task) {
      if (active >= capacity) {
        await new Promise((resolve) => waiting.push(resolve))
      } else {
        active += 1
      }
      try {
        return await task()
      } finally {
        const next = waiting.shift()
        if (next) next()
        else active -= 1
      }
    },
  }
}

/**
 * @returns {<T>(name: string, task: () => Promise<T>) => Promise<T>}
 */
export function createNameLock() {
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map()
  return function run(name, task) {
    const previous = tails.get(name) || Promise.resolve()
    let release = () => {}
    const done = new Promise((resolve) => { release = resolve })
    const tail = previous.then(() => done, () => done)
    tails.set(name, tail)
    return previous.then(task, task).finally(() => {
      release()
      if (tails.get(name) === tail) tails.delete(name)
    })
  }
}
