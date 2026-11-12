/**
 * Minimal MIME: parse inbound mail, assemble outbound mail. Uses only Node
 * built-ins.
 *
 * Covers the encodings real mail runs into: RFC 2047 encoded words
 * (=?UTF-8?B?...?=), quoted-printable, base64, nested multipart, and RFC 2231
 * extended parameter names. Charset decoding is delegated to TextDecoder
 * (Node 22 ships full-icu, so gbk/big5/shift_jis all decode).
 */

const CHARSET_ALIASES = {
  'gb2312': 'gbk',
  'gb_2312': 'gbk',
  'gb_2312-80': 'gbk',
  'csgb2312': 'gbk',
  'chinese': 'gbk',
  'ks_c_5601-1987': 'euc-kr',
  'ks_c_5601-1989': 'euc-kr',
  'iso-8859-1': 'windows-1252',
  'latin1': 'windows-1252',
  'us-ascii': 'utf-8',
  'ascii': 'utf-8',
  'unknown-8bit': 'utf-8',
  'x-unknown': 'utf-8',
  'default': 'utf-8',
  'ansi_x3.4-1968': 'utf-8',
}

export function decodeCharset(buffer, charset) {
  const raw = String(charset ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '')
  const label = CHARSET_ALIASES[raw] ?? raw
  if (label === '' || label === 'utf-8' || label === 'utf8') return buffer.toString('utf8')
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

/** quoted-printable -> raw bytes. Input is treated as a latin1 string, one character = one byte. */
export function decodeQuotedPrintable(input) {
  const out = []
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (char === '=') {
      const hex = input.slice(index + 1, index + 3)
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16))
        index += 2
        continue
      }
      // Soft line break: a `=` immediately followed by the line end means this line is not over yet.
      if (input[index + 1] === '\r' && input[index + 2] === '\n') {
        index += 2
        continue
      }
      if (input[index + 1] === '\n') {
        index += 1
        continue
      }
      out.push(0x3d)
      continue
    }
    const code = char.charCodeAt(0)
    if (code < 0x80) {
      out.push(code)
      continue
    }
    // Should not happen in theory: after latin1 decoding every character is <= 0xFF.
    for (const byte of Buffer.from(char, 'utf8')) out.push(byte)
  }
  return Buffer.from(out)
}

/** Decode RFC 2047 encoded words. Whitespace between adjacent encoded words is dropped per the spec. */
export function decodeWords(value) {
  if (typeof value !== 'string' || value === '') return ''
  const joined = value.replace(/\?=\s+=\?/g, '?==?')
  return joined.replace(/=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, data) => {
    try {
      if (encoding.toUpperCase() === 'B') return decodeCharset(Buffer.from(data, 'base64'), charset)
      return decodeCharset(decodeQuotedPrintable(data.replace(/_/g, ' ')), charset)
    } catch {
      return match
    }
  })
}

function decodeExtendedParameter(value) {
  const match = /^([^']*)'([^']*)'(.*)$/s.exec(value)
  const charset = (match?.[1] || 'utf-8').trim() || 'utf-8'
  const encoded = match ? match[3] : value
  const bytes = Buffer.from(encoded.replace(/%([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1')
  return decodeCharset(bytes, charset)
}

/** Parse a header block (Buffer) -> Map (lowercase keys; folded lines unwrapped, encoded words not yet decoded). */
export function parseHeaders(buffer) {
  const headers = new Map()
  const text = buffer.toString('latin1')
  let name = null
  for (const line of text.split(/\r?\n/)) {
    if (line === '') break
    if (/^[ \t]/.test(line)) {
      if (name) headers.set(name, `${headers.get(name)} ${line.trim()}`)
      continue
    }
    const index = line.indexOf(':')
    if (index < 0) continue
    name = line.slice(0, index).trim().toLowerCase()
    const value = line.slice(index + 1).trim()
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value)
  }
  return headers
}

export function headerValue(headers, name) {
  return decodeWords(headers.get(String(name).toLowerCase()) ?? '')
}

export function parseContentType(value) {
  const params = {}
  if (!value) return { type: 'text/plain', params }
  const pieces = value.split(';')
  const type = (pieces.shift() ?? 'text/plain').trim().toLowerCase()
  let lastName = null
  for (const piece of pieces) {
    const index = piece.indexOf('=')
    if (index < 0) continue
    let key = piece.slice(0, index).trim().toLowerCase()
    let raw = piece.slice(index + 1).trim()
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) raw = raw.slice(1, -1).replace(/\\(.)/g, '$1')

    // RFC 2231: `name*0*=utf-8''...` chunks, or `name*=...` encoded as a whole.
    const continued = /^([^*]+)\*(\d+)\*?$/.exec(key)
    if (continued) {
      const base = continued[1]
      const part = Number(continued[2])
      const decoded = key.endsWith('*') ? decodeExtendedParameter(raw) : raw
      params[`${base}*${part}`] = decoded
      lastName = base
      continue
    }
    if (key.endsWith('*')) {
      params[key.slice(0, -1)] = decodeExtendedParameter(raw)
      continue
    }
    params[key] = raw
  }

  // Reassemble the chunks into one value.
  for (const key of Object.keys(params)) {
    const match = /^([^*]+)\*(\d+)$/.exec(key)
    if (!match) continue
    const base = match[1]
    const parts = Object.keys(params)
      .map((candidate) => /^([^*]+)\*(\d+)$/.exec(candidate))
      .filter((candidate) => candidate && candidate[1] === base)
      .map((candidate) => ({ index: Number(candidate[2]), value: params[candidate[0]] }))
      .sort((a, b) => a.index - b.index)
    params[base] = parts.map((entry) => entry.value).join('')
    for (const entry of parts) delete params[`${base}*${entry.index}`]
  }
  void lastName

  return { type, params }
}

function splitPoint(buffer) {
  const index = buffer.indexOf('\r\n\r\n')
  if (index >= 0) return [index, 4]
  const fallback = buffer.indexOf('\n\n')
  if (fallback >= 0) return [fallback, 2]
  return [buffer.length, 0]
}

export function parseMessage(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  const [headEnd, separator] = splitPoint(buffer)
  return {
    headers: parseHeaders(buffer.subarray(0, headEnd)),
    body: buffer.subarray(headEnd + separator),
  }
}

function splitMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`)
  const parts = []
  let start = body.indexOf(delimiter)
  if (start < 0) return []
  start += delimiter.length
  for (;;) {
    // A `--` right after the delimiter marks the end.
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break
    let cursor = start
    while (cursor < body.length && body[cursor] !== 0x0a) cursor += 1
    cursor += 1
    const next = body.indexOf(delimiter, cursor)
    if (next < 0) {
      parts.push(body.subarray(cursor))
      break
    }
    let end = next
    if (end >= 2 && body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2
    else if (end >= 1 && body[end - 1] === 0x0a) end -= 1
    parts.push(body.subarray(cursor, end))
    start = next + delimiter.length
  }
  return parts
}

/** Flatten a message (possibly nested multipart) into a list of leaf parts. */
export function walkParts(part, out = []) {
  const contentType = parseContentType(part.headers.get('content-type') ?? 'text/plain')
  if (contentType.type.startsWith('multipart/') && contentType.params.boundary) {
    for (const child of splitMultipart(part.body, contentType.params.boundary)) {
      if (child.length === 0) continue
      walkParts(parseMessage(child), out)
    }
    return out
  }
  out.push({ headers: part.headers, body: part.body, contentType })
  return out
}

export function decodePartBody(part) {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '7bit').trim().toLowerCase()
  if (encoding === 'base64') {
    return Buffer.from(part.body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  }
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(part.body.toString('latin1'))
  return part.body
}

export function partText(part) {
  return decodeCharset(decodePartBody(part), part.contentType.params.charset)
}

export function partFilename(part) {
  const disposition = parseContentType(part.headers.get('content-disposition') ?? '')
  const raw = disposition.params.filename ?? part.contentType.params.name ?? ''
  // Many old clients stuff RFC 2047 encoded words straight into filename=
  // instead of using RFC 2231. Without decoding here, non-ASCII attachment
  // names would show up to the user verbatim as `=?utf-8?B?...?=`.
  return raw === '' ? '' : decodeWords(raw).trim()
}

export function stripHtml(html) {
  return String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Extract the body: prefer text/plain, otherwise convert text/html to plain text. */
export function extractText(raw) {
  const leaves = walkParts(parseMessage(raw))
  const plain = []
  const html = []
  for (const leaf of leaves) {
    const disposition = (leaf.headers.get('content-disposition') ?? '').toLowerCase()
    if (disposition.startsWith('attachment')) continue
    if (partFilename(leaf)) continue
    if (leaf.contentType.type === 'text/plain') plain.push(partText(leaf))
    else if (leaf.contentType.type === 'text/html') html.push(partText(leaf))
  }
  const text = plain.join('\n').trim()
  if (text !== '') return { text, fromHtml: false }
  if (html.length > 0) return { text: stripHtml(html.join('\n')), fromHtml: true }
  return { text: '', fromHtml: false }
}

export function extractAttachments(raw) {
  const out = []
  for (const leaf of walkParts(parseMessage(raw))) {
    const filename = partFilename(leaf)
    if (!filename) continue
    out.push({
      filename,
      contentType: leaf.contentType.type,
      content: decodePartBody(leaf),
    })
  }
  return out
}

// ------------------------------------------------------------- outbound assembly

function sanitizeHeader(value) {
  // Header-injection guard: any newline is enough to forge extra headers.
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

export function encodeHeaderValue(value) {
  const text = sanitizeHeader(value)
  if (/^[\x20-\x7e]*$/.test(text)) return text
  // Encoded words cap out at 75 characters; base64 turns every 3 bytes into 4
  // characters, so 45 bytes leaves some margin. Split on **characters** to
  // avoid cutting a multi-byte character in half.
  const chunks = []
  let chunk = ''
  for (const char of text) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 45 && chunk !== '') {
      chunks.push(chunk)
      chunk = char
    } else {
      chunk += char
    }
  }
  if (chunk !== '') chunks.push(chunk)
  return chunks.map((entry) => `=?UTF-8?B?${Buffer.from(entry, 'utf8').toString('base64')}?=`).join(' ')
}

function wrapBase64(buffer) {
  const encoded = buffer.toString('base64')
  const lines = []
  for (let index = 0; index < encoded.length; index += 76) lines.push(encoded.slice(index, index + 76))
  return lines.join('\r\n')
}

function attachmentDisposition(filename) {
  const ascii = sanitizeHeader(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

function extensionType(filename) {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename)
  const map = {
    pdf: 'application/pdf',
    zip: 'application/zip',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return map[(match?.[1] ?? '').toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Assemble one MIME message (returns a Buffer, all line endings CRLF).
 * @param {{from:string,to:string[],cc?:string[],subject:string,text?:string,html?:string,
 *          attachments?:{filename:string,content:Buffer}[]}} input
 */
export function buildMessage(input) {
  const lines = []
  // Must accept varargs: `push(...textPart())` spreads a whole header block
  // into multiple arguments, and forwarding only the first one would silently
  // drop Content-Transfer-Encoding, the blank line and the body.
  const push = (...entries) => lines.push(...entries)
  const to = (input.to ?? []).map(sanitizeHeader).filter(Boolean)
  const cc = (input.cc ?? []).map(sanitizeHeader).filter(Boolean)
  const attachments = input.attachments ?? []
  const text = input.text ?? ''
  const html = input.html ?? ''

  push(`From: ${sanitizeHeader(input.from)}`)
  push(`To: ${to.join(', ')}`)
  if (cc.length > 0) push(`Cc: ${cc.join(', ')}`)
  push(`Subject: ${encodeHeaderValue(input.subject ?? '')}`)
  push(`Date: ${new Date().toUTCString()}`)
  push('MIME-Version: 1.0')

  const textPart = () => [
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(text, 'utf8')),
  ]
  const htmlPart = () => [
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(html, 'utf8')),
  ]

  if (attachments.length === 0) {
    if (html !== '') {
      const boundary = `dsh-alt-${Date.now().toString(36)}`
      push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
      push('')
      push(`--${boundary}`)
      push(...textPart())
      push(`--${boundary}`)
      push(...htmlPart())
      push(`--${boundary}--`)
    } else {
      push(...textPart())
    }
    return Buffer.from(lines.join('\r\n'), 'utf8')
  }

  const mixed = `dsh-mixed-${Date.now().toString(36)}`
  push(`Content-Type: multipart/mixed; boundary="${mixed}"`)
  push('')
  push(`--${mixed}`)
  if (html !== '') {
    const alternative = `dsh-alt-${Date.now().toString(36)}`
    push(`Content-Type: multipart/alternative; boundary="${alternative}"`)
    push('')
    push(`--${alternative}`)
    push(...textPart())
    push(`--${alternative}`)
    push(...htmlPart())
    push(`--${alternative}--`)
  } else {
    push(...textPart())
  }
  for (const attachment of attachments) {
    push(`--${mixed}`)
    push(`Content-Type: ${extensionType(attachment.filename)}; name="${sanitizeHeader(attachment.filename).replace(/[^\x20-\x7e]/g, '_')}"`)
    push(`Content-Disposition: ${attachmentDisposition(attachment.filename)}`)
    push('Content-Transfer-Encoding: base64')
    push('')
    push(wrapBase64(attachment.content))
  }
  push(`--${mixed}--`)
  return Buffer.from(lines.join('\r\n'), 'utf8')
}
