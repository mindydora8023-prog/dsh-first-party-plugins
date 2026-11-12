/**
 * IMAP modified UTF-7 (RFC 3501 section 5.1.3).
 *
 * Why this is needed: Gmail's `X-GM-LABELS` rejects any non-ASCII byte. All five
 * variants we tried (inline UTF-8, IMAP literals, bare atoms) came back with
 * `BAD Could not parse command`. Non-ASCII label names must be encoded as
 * modified UTF-7 (pure ASCII) the old IMAP way, and decoded back to
 * human-readable UTF-8 when read out.
 *
 * Rules: printable ASCII goes through as-is (except `&`, written as `&-`);
 * every other character is joined as UTF-16BE and base64-encoded, with `/`
 * replaced by `,`, `=` padding removed, and wrapped in `&` and `-`.
 */

export function encodeModifiedUtf7(input) {
  const text = String(input ?? '')
  let out = ''
  let pending = ''

  const flush = () => {
    if (pending === '') return
    const buffer = Buffer.alloc(pending.length * 2)
    for (let index = 0; index < pending.length; index += 1) {
      // Write one UTF-16 code unit at a time: surrogate pairs naturally occupy two units, matching the spec.
      buffer.writeUInt16BE(pending.charCodeAt(index), index * 2)
    }
    out += `&${buffer.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`
    pending = ''
  }

  for (const char of text) {
    const code = char.codePointAt(0)
    if (code >= 0x20 && code <= 0x7e) {
      flush()
      out += char === '&' ? '&-' : char
    } else {
      pending += char
    }
  }
  flush()
  return out
}

export function decodeModifiedUtf7(input) {
  return String(input ?? '').replace(/&([^-]*)-/g, (match, encoded) => {
    if (encoded === '') return '&'
    const normalized = encoded.replace(/,/g, '/')
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
    let buffer
    try {
      buffer = Buffer.from(normalized + padding, 'base64')
    } catch {
      return match
    }
    let out = ''
    for (let index = 0; index + 1 < buffer.length; index += 2) {
      out += String.fromCharCode(buffer.readUInt16BE(index))
    }
    return out
  })
}

/** Whether the name contains any non-ASCII character, which decides if modified UTF-7 is needed. */
export function needsModifiedUtf7(value) {
  return /[^\x20-\x7e]/.test(String(value ?? ''))
}
