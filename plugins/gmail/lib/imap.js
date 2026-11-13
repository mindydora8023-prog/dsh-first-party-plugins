/**
 * Minimal IMAP client, just enough: login, list folders, search (including
 * Gmail's X-GM-RAW and X-GM-THRID), fetch, flags, labels, archive, add/remove.
 *
 * Key design points:
 *   - The public API has a single read path, `#readResponse`; every command
 *     goes through it, so untagged responses injected by the server
 *     (`* 3 EXPUNGE` and the like) are absorbed naturally.
 *   - Non-ASCII search terms and label names always go out as IMAP
 *     synchronizing literals instead of being stuffed into quoted strings --
 *     the latter relies on server leniency under UTF-8.
 *   - Every tool call opens a fresh connection: TLS handshake plus login costs
 *     about 0.5 s and buys "never hit a half-dead connection".
 */

import { connect as tlsConnect } from 'node:tls'
import { LineReader, CRLF } from './reader.js'
import { decodeModifiedUtf7, encodeModifiedUtf7, needsModifiedUtf7 } from './utf7.js'

export const ALL_MAIL = '[Gmail]/All Mail'
export const SENT_MAIL = '[Gmail]/Sent Mail'

/** IMAP quoted string: backslashes and quotes must be escaped. */
export function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Values that must go out as a literal: anything outside printable ASCII. */
function needsLiteral(value) {
  return /[^\x20-\x7e]/.test(value)
}

/**
 * Encode a mailbox/label name into wire format.
 *
 * Gmail represents non-ASCII mailbox and label names with modified UTF-7 (that
 * is exactly what LIST returns), so SELECT / EXAMINE / COPY / DELETE must send
 * the same encoding -- sending UTF-8 directly yields `BAD Could not parse
 * command`. Confirmed by experiment.
 */
function encodeMailboxName(name) {
  const value = String(name)
  return needsModifiedUtf7(value) ? encodeModifiedUtf7(value) : value
}

async function openTls(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host })
    const fail = (error) => {
      socket.destroy()
      reject(error)
    }
    socket.setTimeout(timeoutMs, () => fail(new Error(`connection to ${host}:${port} timed out (${timeoutMs}ms)`)))
    socket.once('secureConnect', () => {
      socket.setTimeout(0)
      resolve(socket)
    })
    socket.once('error', fail)
  })
}

export class Imap {
  #reader = null
  #socket = null
  #tag = 0

  constructor({ host = 'imap.gmail.com', port = 993, timeoutMs = 30000 } = {}) {
    this.host = host
    this.port = port
    this.timeoutMs = timeoutMs
  }

  static async open({ host, port, timeoutMs, user, password } = {}) {
    const client = new Imap({ host, port, timeoutMs })
    await client.connect()
    try {
      await client.login(user, password)
    } catch (error) {
      client.close()
      throw error
    }
    return client
  }

  async connect() {
    this.#socket = await openTls(this.host, this.port, this.timeoutMs)
    this.#reader = new LineReader(this.#socket)
    const greeting = await this.#reader.readLine()
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new Error(`IMAP handshake failed: ${greeting}`)
  }

  #nextTag() {
    this.#tag += 1
    return `a${this.#tag}`
  }

  /**
   * Read one complete tagged response, stepping over literals.
   *
   * In a response a literal is marked by a trailing `{n}`, followed by n raw
   * bytes, then the same logical line continues. In the returned `text` each
   * literal is replaced by a `\0LIT<i>\0` placeholder and the raw bytes are
   * kept in `literals[i]`, so callers can regex-parse metadata and still get
   * the bytes.
   */
  async #readResponse(tag) {
    const texts = []
    const literals = []
    for (;;) {
      let line = await this.#reader.readLine()
      for (;;) {
        const match = /\{(\d+)\}$/.exec(line)
        if (!match) break
        texts.push(line)
        const size = Number(match[1])
        literals.push(await this.#reader.readBytes(size))
        texts.push(`\u0000LIT${literals.length - 1}\u0000`)
        line = await this.#reader.readLine()
      }
      texts.push(line)
      if (line.startsWith(`${tag} `) || line === tag) {
        const rest = line.slice(tag.length).trim()
        const status = (rest.split(/\s+/)[0] ?? '').toUpperCase()
        return {
          status,
          statusText: rest.slice(status.length).trim(),
          text: texts.join('\r\n'),
          literals,
        }
      }
    }
  }

  async command(name, args = '') {
    const tag = this.#nextTag()
    const suffix = args === '' ? '' : ` ${args}`
    this.#reader.write(`${tag} ${name}${suffix}${CRLF}`)
    return this.#readResponse(tag)
  }

  /** Send a command with one literal: `<prefix> {n}\r\n<bytes><suffix>\r\n`. */
  async commandWithLiteral(name, prefix, literal, suffix = '') {
    const tag = this.#nextTag()
    const body = Buffer.isBuffer(literal) ? literal : Buffer.from(String(literal), 'utf8')
    const head = prefix === '' ? `${tag} ${name} {${body.length}}` : `${tag} ${name} ${prefix} {${body.length}}`
    this.#reader.write(head + CRLF)
    const continuation = await this.#reader.readLine()
    if (!continuation.startsWith('+')) throw new Error(`IMAP rejected the literal: ${continuation}`)
    this.#reader.write(body)
    this.#reader.write(suffix + CRLF)
    return this.#readResponse(tag)
  }

  async login(user, password) {
    const response = await this.command('LOGIN', `${quote(user)} ${quote(password)}`)
    if (response.status !== 'OK') {
      throw new Error(`IMAP login failed: ${response.statusText || response.status}`)
    }
  }

  async capabilities() {
    const response = await this.command('CAPABILITY')
    const line = response.text.split(/\r?\n/).find((entry) => entry.startsWith('* CAPABILITY'))
    return line ? line.replace('* CAPABILITY', '').trim().split(/\s+/) : []
  }

  async list() {
    const response = await this.command('LIST', '"" "*"')
    const out = []
    for (const line of response.text.split(/\r?\n/)) {
      const match = /^\* LIST \(([^)]*)\)\s+"?([^"]*)"?\s+(.+)$/.exec(line)
      if (!match) continue
      let name = match[3].trim()
      if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1')
      out.push({ name: decodeModifiedUtf7(name), flags: match[1].split(/\s+/).filter(Boolean), delimiter: match[2] })
    }
    return out
  }

  async select(mailbox, { readonly = true } = {}) {
    const response = await this.command(readonly ? 'EXAMINE' : 'SELECT', quote(encodeMailboxName(mailbox)))
    if (response.status !== 'OK') throw new Error(`cannot open mailbox ${mailbox}: ${response.statusText}`)
    const exists = /\*\s+(\d+)\s+EXISTS/.exec(response.text)
    return { exists: exists ? Number(exists[1]) : null }
  }

  /**
   * UID search. `raw` goes through Gmail's X-GM-RAW (full Gmail search syntax).
   * Returns an array of UID strings, descending (newest first).
   */
  async search({ raw = '', unread = false, mailbox = ALL_MAIL } = {}) {
    await this.select(mailbox, { readonly: true })
    const extra = unread ? ' UNSEEN' : ''
    let response
    if (raw !== '') {
      response = needsLiteral(raw)
        ? await this.commandWithLiteral('UID SEARCH', 'CHARSET UTF-8 X-GM-RAW', Buffer.from(raw, 'utf8'), extra)
        : await this.command('UID SEARCH', `X-GM-RAW ${quote(raw)}${extra}`)
    } else {
      response = await this.command('UID SEARCH', unread ? 'UNSEEN' : 'ALL')
    }
    if (response.status !== 'OK') throw new Error(`UID SEARCH failed: ${response.statusText}`)

    const uids = []
    for (const line of response.text.split(/\r?\n/)) {
      if (!line.startsWith('* SEARCH')) continue
      for (const token of line.slice('* SEARCH'.length).trim().split(/\s+/)) {
        if (/^\d+$/.test(token)) uids.push(token)
      }
    }
    uids.sort((a, b) => Number(b) - Number(a))
    return uids
  }

  async searchByThread(threadId, { mailbox = ALL_MAIL } = {}) {
    await this.select(mailbox, { readonly: true })
    const response = await this.command('UID SEARCH', `X-GM-THRID ${threadId}`)
    if (response.status !== 'OK') throw new Error(`thread search failed: ${response.statusText}`)
    const uids = []
    for (const line of response.text.split(/\r?\n/)) {
      if (!line.startsWith('* SEARCH')) continue
      for (const token of line.slice('* SEARCH'.length).trim().split(/\s+/)) {
        if (/^\d+$/.test(token)) uids.push(token)
      }
    }
    uids.sort((a, b) => Number(b) - Number(a))
    return uids
  }

  /** Fetch a message by UID. `items` are FETCH data items such as `BODY.PEEK[]`. */
  async fetch(uid, items, { mailbox = ALL_MAIL } = {}) {
    await this.select(mailbox, { readonly: true })
    const response = await this.command('UID FETCH', `${uid} (${items})`)
    if (response.status !== 'OK') throw new Error(`UID FETCH ${uid} failed: ${response.statusText}`)
    const literal = response.literals[0] ?? null
    return { meta: parseFetchMeta(response.text), literal, text: response.text }
  }

  async storeFlags(uids, mode, flags, { mailbox = ALL_MAIL } = {}) {
    await this.select(mailbox, { readonly: false })
    const list = Array.isArray(uids) ? uids.join(',') : String(uids)
    const value = flags.map((flag) => (flag.startsWith('\\') ? flag : `\\${flag}`)).join(' ')
    const response = await this.command('UID STORE', `${list} ${mode}FLAGS (${value})`)
    if (response.status !== 'OK') throw new Error(`UID STORE failed: ${response.statusText}`)
    return response
  }

  /**
   * Add/remove Gmail labels.
   *
   * Non-ASCII label names must first be encoded as modified UTF-7: Gmail's
   * X-GM-LABELS rejects UTF-8 bytes (inline quoted, IMAP literal or bare atom
   * alike) with `BAD Could not parse command` -- all five variants we tried
   * were rejected, while a modified UTF-7 form such as `"DSH&gepowA-"` could be
   * written and read back normally.
   */
  async storeLabels(uids, mode, names, { mailbox = ALL_MAIL } = {}) {
    if (names.length === 0) return null
    await this.select(mailbox, { readonly: false })
    const list = Array.isArray(uids) ? uids.join(',') : String(uids)
    const encoded = names.map((name) => (needsModifiedUtf7(name) ? encodeModifiedUtf7(name) : name))
    const inner = encoded.map((name) => quote(name)).join(' ')
    const item = `${mode}X-GM-LABELS`
    const response = await this.command('UID STORE', `${list} ${item} (${inner})`)
    if (response.status !== 'OK') throw new Error(`label operation failed: ${response.statusText}`)
    return response
  }

  async labelsOf(uid, { mailbox = ALL_MAIL } = {}) {
    await this.select(mailbox, { readonly: true })
    const response = await this.command('UID FETCH', `${uid} (X-GM-LABELS)`)
    if (response.status !== 'OK') return []
    return parseFetchMeta(response.text).labels
  }
  async copy(uid, mailbox) {
    const response = await this.command('UID COPY', `${uid} ${quote(encodeMailboxName(mailbox))}`)
    if (response.status !== 'OK') throw new Error(`UID COPY failed: ${response.statusText}`)
    return response
  }

  async expunge({ mailbox = 'INBOX' } = {}) {
    await this.select(mailbox, { readonly: false })
    const response = await this.command('EXPUNGE')
    if (response.status !== 'OK') throw new Error(`EXPUNGE failed: ${response.statusText}`)
    return response
  }

  /**
   * Expunge ONLY the given UIDs (RFC 4315 UIDPLUS, supported by Gmail).
   *
   * `expunge()` sends a bare EXPUNGE, which permanently removes EVERY message
   * flagged \Deleted in the mailbox. When the intent is to remove one message we
   * just archived, a bare EXPUNGE could delete unrelated messages the user had
   * marked for deletion but not yet expunged. UID EXPUNGE is scoped to the set.
   *
   * @param {string[]|number[]} uids - uids to expunge.
   * @param {{mailbox?: string}} [options]
   */
  async uidExpunge(uids, { mailbox = 'INBOX' } = {}) {
    const set = (Array.isArray(uids) ? uids : [uids]).map((uid) => String(uid).trim()).filter(Boolean)
    if (set.length === 0) return { status: 'OK', statusText: 'nothing to expunge', text: '' }
    await this.select(mailbox, { readonly: false })
    const response = await this.command('UID EXPUNGE', set.join(','))
    if (response.status !== 'OK') throw new Error(`UID EXPUNGE failed: ${response.statusText}`)
    return response
  }

  async selectWritable(mailbox) {
    return this.select(mailbox, { readonly: false })
  }

  async logout() {
    try {
      await this.command('LOGOUT')
    } catch {
      /* fine even if the connection is already gone */
    }
    this.close()
  }

  close() {
    this.#reader?.end()
    this.#reader = null
    this.#socket = null
  }
}

/** Pull metadata out of FETCH response text. Literals are already placeholders, so the regexes cannot misfire. */
export function parseFetchMeta(text) {
  const meta = { uid: null, threadId: null, flags: [], labels: [], internalDate: null }
  const uid = /\bUID (\d+)/.exec(text)
  if (uid) meta.uid = uid[1]
  const thread = /X-GM-THRID (\d+)/.exec(text)
  if (thread) meta.threadId = thread[1]
  const flags = /FLAGS \(([^)]*)\)/.exec(text)
  if (flags) meta.flags = flags[1].split(/\s+/).filter(Boolean)
  const labels = /X-GM-LABELS \(([^)]*)\)/.exec(text)
  if (labels) {
    meta.labels = []
    const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g
    let match
    while ((match = pattern.exec(labels[1])) !== null) {
      const value = match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2]
      // Gmail returns non-ASCII label names as modified UTF-7; decode them back to readable text.
      if (value) meta.labels.push(decodeModifiedUtf7(value))
    }
  }
  const date = /INTERNALDATE "([^"]+)"/.exec(text)
  if (date) meta.internalDate = date[1]
  return meta
}
