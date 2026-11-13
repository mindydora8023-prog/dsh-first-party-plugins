/**
 * Socket reader for line and byte-oriented reads, shared by IMAP and SMTP.
 *
 * Why it is hand-written: IMAP has literals (`{1234}\r\n` followed by 1234 raw
 * bytes), so treating the socket as a plain text stream falls over on the first
 * binary attachment. This keeps "read one line" and "read exactly n bytes"
 * separate and lets the caller compose them.
 *
 * Buffering note: incoming chunks are queued, not concatenated on arrival. A
 * `Buffer.concat([buffer, chunk])` per data event is O(n^2) over a large literal
 * (a 20 MB attachment arrives in ~320 chunks, each copying the growing buffer).
 * Instead the chunks are merged exactly once, when a read actually consumes them.
 */

export const CRLF = '\r\n'

export class LineReader {
  #socket
  #buffer = Buffer.alloc(0)
  #chunks = []
  #buffered = 0
  #ended = null
  #wake = null

  constructor(socket) {
    this.#socket = socket
    socket.on('data', (chunk) => {
      this.#chunks.push(chunk)
      this.#buffered += chunk.length
      this.#notify()
    })
    socket.on('error', (error) => {
      this.#ended ??= error
      this.#notify()
    })
    socket.on('close', () => {
      this.#ended ??= new Error('the connection was closed by the remote side')
      this.#notify()
    })
  }

  #notify() {
    const wake = this.#wake
    this.#wake = null
    if (wake) wake()
  }

  /** Merge queued socket chunks into #buffer. Called once per consuming read. */
  #flatten() {
    if (this.#chunks.length === 0) return
    this.#buffer = this.#buffer.length === 0
      ? Buffer.concat(this.#chunks)
      : Buffer.concat([this.#buffer, ...this.#chunks])
    this.#chunks = []
  }

  /**
   * Wait for the next batch of data.
   *
   * #wake is only ever set on the synchronous path: Node's single-threaded model
   * guarantees a data callback cannot interleave between "check the buffer" and
   * "attach the waker", so there is no lost-wakeup window.
   */
  #wait() {
    if (this.#wake) return Promise.reject(new Error('read re-entry: the previous read has not finished'))
    return new Promise((resolve) => {
      this.#wake = resolve
    })
  }

  /** Read one line (the trailing CRLF is not included). */
  async readLine() {
    for (;;) {
      const index = this.#buffer.indexOf(0x0a)
      if (index >= 0) {
        let line = this.#buffer.subarray(0, index)
        this.#buffer = this.#buffer.subarray(index + 1)
        this.#buffered -= index + 1
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
        return line.toString('utf8')
      }
      // A newline may be sitting in a not-yet-merged chunk; merge and re-scan
      // before deciding we need to wait for more data.
      if (this.#chunks.length > 0) {
        this.#flatten()
        continue
      }
      if (this.#ended) throw this.#ended
      await this.#wait()
    }
  }

  /** Read exactly count bytes. */
  async readBytes(count) {
    // Count bytes as they stream in; flatten only once we have enough. Flattening
    // inside this loop would copy the growing buffer per chunk and restore O(n^2).
    while (this.#buffered < count) {
      if (this.#ended) {
        this.#flatten()
        if (this.#buffered < count) throw this.#ended
        break
      }
      await this.#wait()
    }
    this.#flatten()
    const out = Buffer.from(this.#buffer.subarray(0, count))
    this.#buffer = this.#buffer.subarray(count)
    this.#buffered -= count
    return out
  }

  write(data) {
    if (this.#ended) throw this.#ended
    this.#socket.write(data)
  }

  end() {
    try {
      this.#socket.end()
    } catch {
      /* already closed; nothing left to do */
    }
  }

  destroy() {
    try {
      this.#socket.destroy()
    } catch {
      /* same as end(): the socket is already gone */
    }
  }
}
