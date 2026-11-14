/**
 * Minimal SMTP sender (implicit TLS on 465 + AUTH LOGIN).
 *
 * Does only what sending needs: EHLO -> AUTH LOGIN -> MAIL FROM -> RCPT TO ->
 * DATA (with dot stuffing) -> QUIT. Gmail files the copy into "Sent Mail"
 * itself, so there is no extra APPEND here.
 */

import { hostname } from 'node:os'
import { connect as tlsConnect } from 'node:tls'
import { LineReader, CRLF } from './reader.js'

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

function clientName() {
  const raw = hostname() ?? 'localhost'
  const cleaned = raw.replace(/[^A-Za-z0-9.-]/g, '-')
  return cleaned === '' ? 'localhost' : cleaned
}

/** A continuation flood must not be read without a bound. */
export const MAX_SMTP_LINES = 40

/** Read one SMTP response (possibly multiline). */
export async function readReply(reader) {
  const lines = []
  for (;;) {
    if (lines.length >= MAX_SMTP_LINES) {
      throw new Error(`SMTP response exceeded ${MAX_SMTP_LINES} lines`)
    }
    const line = await reader.readLine()
    lines.push(line)
    const match = /^(\d{3})([ -]?)/.exec(line)
    if (!match) continue
    if (match[2] === '-') continue
    return { code: match[1], text: lines.join('\n') }
  }
}

async function command(reader, text) {
  reader.write(text + CRLF)
  return readReply(reader)
}

/** DATA phase: a leading `.` must be written as `..`, otherwise it is taken as the terminator. */
function dotStuff(buffer) {
  return buffer
    .toString('latin1')
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n')
}

/**
 * A send failure that records how far the exchange got.
 *
 * The phase decides whether a retry is safe: before the DATA payload is written
 * the message cannot have been delivered, so retrying is harmless. After the
 * payload is written the server may already have accepted it, and a retry would
 * duplicate the mail -- the caller must report that as an unknown outcome.
 *
 * @param {string} message - model-facing detail.
 * @param {string} phase - the SMTP stage that failed.
 * @returns {Error} an error carrying `smtpPhase` and `deliveryPossible`.
 */
function smtpError(message, phase) {
  const error = new Error(message)
  error.smtpPhase = phase
  error.deliveryPossible = phase === 'data-body' || phase === 'data-reply'
  return error
}

/**
 * Send an already assembled MIME message.
 * @returns {Promise<{code:string,text:string}>}
 */
export async function sendMail({ host = 'smtp.gmail.com', port = 465, user, password, from, recipients, message, timeoutMs = 90000 }) {
  const socket = await openTls(host, port, timeoutMs)
  const reader = new LineReader(socket, { idleMs: timeoutMs })
  try {
    const greeting = await readReply(reader)
    if (!greeting.code.startsWith('2')) throw smtpError(`SMTP handshake failed: ${greeting.text}`, 'greeting')

    const ehlo = await command(reader, `EHLO ${clientName()}`)
    if (ehlo.code !== '250') throw smtpError(`SMTP EHLO failed: ${ehlo.text}`, 'ehlo')

    const authStart = await command(reader, 'AUTH LOGIN')
    if (authStart.code !== '334') throw smtpError(`server does not support AUTH LOGIN: ${authStart.text}`, 'auth')

    const authUser = await command(reader, Buffer.from(user, 'utf8').toString('base64'))
    if (authUser.code !== '334') throw smtpError(`SMTP auth step 1 rejected: ${authUser.text}`, 'auth')

    const authPass = await command(reader, Buffer.from(password, 'utf8').toString('base64'))
    if (authPass.code !== '235') {
      throw smtpError(
        `SMTP authentication failed (wrong or revoked app password): ${authPass.text}`,
        'auth',
      )
    }

    const mailFrom = await command(reader, `MAIL FROM:<${from}>`)
    if (mailFrom.code !== '250') throw smtpError(`MAIL FROM rejected: ${mailFrom.text}`, 'mail-from')

    for (const recipient of recipients) {
      const rcpt = await command(reader, `RCPT TO:<${recipient}>`)
      if (!/^25\d$/.test(rcpt.code)) throw smtpError(`recipient rejected ${recipient}: ${rcpt.text}`, 'rcpt')
    }

    const data = await command(reader, 'DATA')
    if (data.code !== '354') throw smtpError(`DATA rejected: ${data.text}`, 'data-command')

    // From here the message body is on the wire: a failure may still have been
    // delivered, so the caller must not treat it as a clean no-op.
    reader.write(Buffer.from(`${dotStuff(message)}${CRLF}.${CRLF}`, 'latin1'))
    let accepted
    try {
      accepted = await readReply(reader)
    } catch (error) {
      throw smtpError(`delivery outcome unknown: ${error?.message ?? String(error)}`, 'data-reply')
    }
    if (accepted.code !== '250') throw smtpError(`delivery failed: ${accepted.text}`, 'data-reply')

    await command(reader, 'QUIT').catch(() => undefined)
    return { code: accepted.code, text: accepted.text }
  } finally {
    reader.end()
  }
}
