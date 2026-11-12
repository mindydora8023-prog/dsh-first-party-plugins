/**
 * Tool definitions: the gmail_* family.
 *
 * Conventions:
 *   - Every tool call opens a fresh IMAP connection (about 0.5s) in exchange
 *     for "never hitting a half-dead connection".
 *   - Reads always use BODY.PEEK, so unread never turns into read.
 *   - Listing takes headers only (fast); optional `preview` also fetches a
 *     body snippet.
 *   - State changes (mark/label/archive) are gated by `allowWrite`, sending by
 *     `allowSend`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { ALL_MAIL, Imap } from './imap.js'
import {
  buildMessage,
  decodeWords,
  extractAttachments,
  extractText,
  parseHeaders,
} from './mime.js'
import { sendMail } from './smtp.js'
import { assertNotStopped, loadCredentials, readState, writeState } from './config.js'

const text = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
]

function jsonOutput() {
  // An object root must declare additionalProperties explicitly, or the schema compiler rejects it outright.
  return { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value) }
}

const GMAIL_SEARCH_HELP =
  'Gmail search syntax: from: to: subject: has:attachment filename:pdf newer_than:7d older_than:1m ' +
  'is:unread is:starred in:inbox label:name -from:exclude@x.com. Leave empty to list everything.'

const MAILBOX_PARAM = {
  type: 'string',
  description: "Mailbox to operate on. Defaults to '[Gmail]/All Mail' (everything except Spam/Trash). Use 'INBOX' for the inbox only.",
}

async function withImap(config, fn) {
  assertNotStopped(config)
  const credentials = loadCredentials(config)
  const client = await Imap.open({
    host: config.imapHost,
    port: config.imapPort,
    timeoutMs: config.timeoutMs,
    user: credentials.address,
    password: credentials.password,
  })
  try {
    return await fn(client, credentials)
  } finally {
    client.close()
  }
}

function assertSignal(exec) {
  if (exec?.signal?.aborted) throw new Error('the call was cancelled')
}

function checkWrite(config, what) {
  if (!config.allowWrite) throw new Error(`${what} is disabled by plugin config (allowWrite: false)`)
}

function checkSend(config) {
  if (!config.allowSend) throw new Error('sending mail is disabled by plugin config (allowSend: false)')
}

/** Read sender/subject/date and so on from a header-only literal. */
function headersFromLiteral(literal) {
  const headers = parseHeaders(literal ?? Buffer.alloc(0))
  return {
    from: decodeWords(headers.get('from') ?? ''),
    to: decodeWords(headers.get('to') ?? ''),
    subject: decodeWords(headers.get('subject') ?? ''),
    date: decodeWords(headers.get('date') ?? ''),
    messageId: decodeWords(headers.get('message-id') ?? ''),
  }
}

function summarizeEntry(uid, meta, literal) {
  const headers = headersFromLiteral(literal)
  return {
    uid: String(uid),
    thread_id: meta.threadId,
    date: headers.date,
    from: headers.from,
    to: headers.to,
    subject: headers.subject || '(no subject)',
    message_id: headers.messageId,
    unread: !meta.flags.includes('\\Seen'),
    starred: meta.flags.includes('\\Flagged'),
    labels: meta.labels,
  }
}

function snippetOf(raw, limit) {
  const { text: body } = extractText(raw)
  return body.replace(/\s+/g, ' ').slice(0, limit)
}

const LIST_ITEMS = 'UID X-GM-THRID FLAGS X-GM-LABELS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)]'
const FULL_ITEMS = 'UID X-GM-THRID FLAGS X-GM-LABELS INTERNALDATE BODY.PEEK[]'

function safeFilename(name, fallback) {
  const cleaned = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned === '' ? fallback : cleaned.slice(0, 180)
}

/**
 * Turn a send failure into the record the model receives.
 *
 * The decision that matters is whether the message may already have left the
 * server. Before the DATA body is written nothing was delivered, so a retry is
 * safe; after it the outcome is unknown and re-sending would duplicate the
 * mail. Pure function, so this contract is testable without a network.
 *
 * @param error The error thrown by `sendMail`.
 * @param envelope `{from, to, cc}` to echo back.
 */
export function sendFailureRecord(error, envelope) {
  const possible = error !== null && typeof error === 'object' && error.deliveryPossible === true
  return {
    status: possible ? 'unknown' : 'error',
    sent: false,
    error: {
      code: possible ? 'DELIVERY_OUTCOME_UNKNOWN' : 'SEND_FAILED',
      effectState: possible ? 'unknown' : 'none',
      retry: possible ? 'never' : 'after-input-change',
      phase: error !== null && typeof error === 'object' && typeof error.smtpPhase === 'string'
        ? error.smtpPhase
        : 'unknown',
      message: error instanceof Error ? error.message : String(error),
      nextAction: possible
        ? 'Do not resend. Check the Sent folder or ask the recipient whether it arrived before sending again.'
        : 'Correct the address, credentials or server setting, then send again.',
    },
    from: envelope.from,
    to: envelope.to,
    cc: envelope.cc,
  }
}

/**
 * Build all tool definitions.
 * @param config Normalized plugin config
 * @param logger Host logger
 */
export function buildTools(config, logger) {
  const tools = []

  async function collect(uids, { mailbox, preview, previewLimit, exec, maxPreviewChars }) {
    const previewed = new Set()
    if (preview) {
      for (const uid of uids) {
        if (previewed.size >= previewLimit) break
        previewed.add(uid)
      }
    }
    return withImap(config, async (client) => {
      const entries = []
      for (const uid of uids) {
        assertSignal(exec)
        const useFull = previewed.has(uid)
        const { meta, literal } = await client.fetch(uid, useFull ? FULL_ITEMS : LIST_ITEMS, { mailbox })
        const entry = summarizeEntry(uid, meta, literal)
        if (useFull && literal) {
          entry.snippet = snippetOf(literal, maxPreviewChars)
          entry.attachments = extractAttachments(literal).map((item) => item.filename)
        }
        entries.push(entry)
      }
      return entries
    })
  }

  // -------------------------------------------------------------------- state

  tools.push({
    name: 'gmail_status',
    description:
      'Check the Gmail connection: signs in over IMAP, reports the account address, credential source, and message counts per folder. Use it first when mail tools fail, or to confirm which account is connected. Never returns the password.',
    parameters: {},
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute() {
      assertNotStopped(config)
      const credentials = loadCredentials(config)
      return withImap(config, async (client) => {
        const folders = await client.list()
        const counts = {}
        for (const box of ['INBOX', ALL_MAIL, '[Gmail]/Sent Mail', '[Gmail]/Drafts', '[Gmail]/Trash', '[Gmail]/Spam']) {
          try {
            const { exists } = await client.select(box, { readonly: true })
            counts[box] = exists
          } catch {
            counts[box] = null
          }
        }
        return {
          ok: true,
          address: credentials.address,
          credential_source: credentials.source,
          folders: folders.map((folder) => folder.name),
          counts,
          write_enabled: config.allowWrite,
          send_enabled: config.allowSend,
        }
      })
    },
  })

  // ------------------------------------------------------------------- search

  tools.push({
    name: 'gmail_search',
    description:
      `Search or list mail and return per-message metadata (uid, thread_id, date, from, to, subject, read/starred state, labels). ${GMAIL_SEARCH_HELP} ` +
      'Results are newest first. Pass preview:true to also get a short body snippet and attachment filenames for the first few messages. Use the returned uid with gmail_read and the thread_id with gmail_thread.',
    parameters: {
      query: { type: 'string', description: `Gmail search query. ${GMAIL_SEARCH_HELP}` },
      unread: { type: 'boolean', description: 'Only unread messages.' },
      limit: { type: 'number', description: `Maximum results (default ${config.maxResults}, max ${config.maxResultsLimit}).` },
      mailbox: MAILBOX_PARAM,
      preview: { type: 'boolean', description: 'Also fetch a body snippet and attachment names for the first few results (default true).' },
      preview_limit: { type: 'number', description: 'How many results to preview (default 5).' },
    },
    output: jsonOutput(),
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const limit = Math.min(Math.max(1, Math.trunc(Number(args.limit) || config.maxResults)), config.maxResultsLimit)
      const mailbox = typeof args.mailbox === 'string' && args.mailbox.trim() !== '' ? args.mailbox.trim() : ALL_MAIL
      const preview = args.preview !== false
      const previewLimit = Math.min(Math.max(0, Math.trunc(Number(args.preview_limit) || 5)), 20)
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const unread = args.unread === true

      return withImap(config, async (client) => {
        const all = await client.search({ raw: query, unread, mailbox })
        const uids = all.slice(0, limit)
        if (uids.length === 0) return { count: 0, matched: all.length, messages: [] }
        const entries = await collect(uids, { mailbox, preview, previewLimit, exec, maxPreviewChars: 300 })
        return { count: entries.length, matched: all.length, messages: entries }
      })
    },
  })

  // --------------------------------------------------------------------- read

  tools.push({
    name: 'gmail_read',
    description:
      'Read one message in full by uid (get uids from gmail_search). Returns headers, the decoded plain-text body, and attachment filenames. Reading never marks the message as read. Set save_attachments:true to write attachments to disk and get their paths back.',
    parameters: {
      uid: { type: 'string', required: true, description: 'Message uid from gmail_search.' },
      mailbox: MAILBOX_PARAM,
      max_chars: { type: 'number', description: 'Truncate the body at this many characters (default 8000).' },
      save_attachments: { type: 'boolean', description: 'Save attachments to disk and return their absolute paths.' },
    },
    output: jsonOutput(),
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertSignal(exec)
      const uid = String(args.uid).trim()
      const mailbox = typeof args.mailbox === 'string' && args.mailbox.trim() !== '' ? args.mailbox.trim() : ALL_MAIL
      const maxChars = Math.max(200, Math.trunc(Number(args.max_chars) || 8000))

      return withImap(config, async (client) => {
        const { meta, literal } = await client.fetch(uid, FULL_ITEMS, { mailbox })
        if (!literal) throw new Error(`uid ${uid} returned no content (it may have been deleted or may not be in ${mailbox})`)
        const entry = summarizeEntry(uid, meta, literal)
        const { text: body, fromHtml } = extractText(literal)
        const attachments = extractAttachments(literal)

        const saved = []
        if (args.save_attachments === true && attachments.length > 0) {
          const directory = join(config.attachmentsDir, uid)
          mkdirSync(directory, { recursive: true })
          for (const attachment of attachments) {
            const target = join(directory, safeFilename(attachment.filename, 'attachment.bin'))
            writeFileSync(target, attachment.content)
            saved.push(target)
          }
        }
        return {
          ...entry,
          cc: decodeWords(parseHeaders(literal).get('cc') ?? ''),
          body: body.length > maxChars ? body.slice(0, maxChars) : body,
          body_truncated: body.length > maxChars,
          body_length: body.length,
          body_from_html: fromHtml,
          attachments: attachments.map((item) => ({ filename: item.filename, bytes: item.content.length, type: item.contentType })),
          saved_attachments: saved,
        }
      })
    },
  })

  tools.push({
    name: 'gmail_thread',
    description:
      'Read a whole Gmail conversation by thread_id (from gmail_search). Returns every message in the thread oldest-first, each with its own body. Use this to summarise a back-and-forth instead of reading messages one by one.',
    parameters: {
      thread_id: { type: 'string', required: true, description: 'Gmail thread id (X-GM-THRID) from gmail_search.' },
      mailbox: MAILBOX_PARAM,
      max_chars_per_message: { type: 'number', description: 'Truncate each message body (default 4000).' },
      limit: { type: 'number', description: 'Maximum messages to return (default 20).' },
    },
    output: jsonOutput(),
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertSignal(exec)
      const threadId = String(args.thread_id).trim()
      const mailbox = typeof args.mailbox === 'string' && args.mailbox.trim() !== '' ? args.mailbox.trim() : ALL_MAIL
      const maxChars = Math.max(200, Math.trunc(Number(args.max_chars_per_message) || 4000))
      const limit = Math.min(Math.max(1, Math.trunc(Number(args.limit) || 20)), 100)

      return withImap(config, async (client) => {
        const uids = (await client.searchByThread(threadId, { mailbox })).slice(0, limit)
        const messages = []
        for (const uid of uids) {
          assertSignal(exec)
          const { meta, literal } = await client.fetch(uid, FULL_ITEMS, { mailbox })
          if (!literal) continue
          const entry = summarizeEntry(uid, meta, literal)
          const { text: body } = extractText(literal)
          messages.push({
            ...entry,
            body: body.length > maxChars ? body.slice(0, maxChars) : body,
            body_truncated: body.length > maxChars,
          })
        }
        // IMAP returns newest first; a thread reads naturally in chronological order.
        messages.sort((a, b) => {
          const left = Date.parse(a.date)
          const right = Date.parse(b.date)
          if (Number.isNaN(left) || Number.isNaN(right)) return 0
          return left - right
        })
        return { thread_id: threadId, count: messages.length, messages }
      })
    },
  })

  // --------------------------------------------------------------------- send

  tools.push({
    name: 'gmail_send',
    description:
      'Send an email from the connected Gmail account, optionally with file attachments. Gmail keeps a copy in Sent automatically. Confirm the recipients, subject and body with the user before sending unless they already stated them.',
    parameters: {
      to: { type: 'array', items: { type: 'string' }, required: true, description: 'Recipient addresses.' },
      subject: { type: 'string', required: true, description: 'Subject line (Unicode is fine).' },
      body: { type: 'string', description: 'Plain-text body.' },
      cc: { type: 'array', items: { type: 'string' }, description: 'Cc addresses.' },
      html_body: { type: 'string', description: 'Optional HTML body; goes out as a multipart/alternative alongside body.' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files to attach (25 MB total limit).' },
    },
    output: jsonOutput(),
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertSignal(exec)
      checkSend(config)
      assertNotStopped(config)
      const credentials = loadCredentials(config)

      const to = (Array.isArray(args.to) ? args.to : []).map((value) => String(value).trim()).filter(Boolean)
      if (to.length === 0) throw new Error('at least one recipient (to) is required')
      const cc = (Array.isArray(args.cc) ? args.cc : []).map((value) => String(value).trim()).filter(Boolean)
      for (const address of [...to, ...cc]) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error(`invalid recipient address: ${address}`)
      }

      const attachments = []
      let totalBytes = 0
      for (const entry of Array.isArray(args.attachments) ? args.attachments : []) {
        const path = isAbsolute(String(entry)) ? String(entry) : resolve(config.dirs.pluginDir, String(entry))
        if (!existsSync(path)) throw new Error(`attachment does not exist: ${path}`)
        const stats = statSync(path)
        if (!stats.isFile()) throw new Error(`attachment is not a file: ${path}`)
        totalBytes += stats.size
        if (totalBytes > 25 * 1024 * 1024) throw new Error("attachments exceed Gmail's 25 MB total limit")
        attachments.push({ filename: basename(path), content: readFileSync(path) })
      }

      const message = buildMessage({
        from: credentials.address,
        to,
        cc,
        subject: args.subject ?? '',
        text: args.body ?? '',
        html: typeof args.html_body === 'string' ? args.html_body : '',
        attachments,
      })

      let result
      try {
        result = await sendMail({
          host: config.smtpHost,
          port: config.smtpPort,
          user: credentials.address,
          password: credentials.password,
          from: credentials.address,
          recipients: [...to, ...cc],
          message,
          timeoutMs: config.timeoutMs * 2,
        })
      } catch (error) {
        // A send failure is reported, not thrown: the model must be able to tell
        // whether the mail may already have left the server.
        return sendFailureRecord(error, { from: credentials.address, to, cc })
      }
      logger?.info?.('gmail: sent mail to %s', to.join(', '))
      return {
        status: 'completed',
        sent: true,
        from: credentials.address,
        to,
        cc,
        subject: args.subject ?? '',
        attachments: attachments.map((item) => ({ filename: item.filename, bytes: item.content.length })),
        server_response: result.text,
      }
    },
  })

  // ------------------------------------------------------------- state changes

  tools.push({
    name: 'gmail_mark',
    description: 'Change the read or starred state of one or more messages by uid. This is a write operation.',
    parameters: {
      uids: { type: 'array', items: { type: 'string' }, required: true, description: 'Message uids to update.' },
      action: {
        type: 'string',
        required: true,
        description: "One of 'seen' (mark read), 'unseen' (mark unread), 'star', 'unstar'.",
      },
      mailbox: MAILBOX_PARAM,
    },
    output: jsonOutput(),
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args) {
      checkWrite(config, 'change message flags')
      const uids = (Array.isArray(args.uids) ? args.uids : []).map((value) => String(value).trim()).filter(Boolean)
      if (uids.length === 0) throw new Error('at least one uid is required')
      const mailbox = typeof args.mailbox === 'string' && args.mailbox.trim() !== '' ? args.mailbox.trim() : ALL_MAIL
      const actions = {
        seen: ['+', ['\\Seen']],
        unseen: ['-', ['\\Seen']],
        star: ['+', ['\\Flagged']],
        unstar: ['-', ['\\Flagged']],
      }
      const chosen = actions[String(args.action ?? '').trim().toLowerCase()]
      if (!chosen) throw new Error('action must be one of seen / unseen / star / unstar')

      return withImap(config, async (client) => {
        await client.storeFlags(uids, chosen[0], chosen[1], { mailbox })
        return { updated: uids, action: args.action }
      })
    },
  })

  tools.push({
    name: 'gmail_label',
    description:
      'Add and/or remove Gmail labels on messages by uid. Use gmail_status or read a message to discover label names. Removing the label "\\Inbox" archives a message. This is a write operation.',
    parameters: {
      uids: { type: 'array', items: { type: 'string' }, required: true, description: 'Message uids to update.' },
      add: { type: 'array', items: { type: 'string' }, description: 'Label names to add (created automatically by Gmail).' },
      remove: { type: 'array', items: { type: 'string' }, description: 'Label names to remove. "\\Inbox" removes it from the inbox.' },
      mailbox: MAILBOX_PARAM,
    },
    output: jsonOutput(),
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args) {
      checkWrite(config, 'change message labels')
      const uids = (Array.isArray(args.uids) ? args.uids : []).map((value) => String(value).trim()).filter(Boolean)
      if (uids.length === 0) throw new Error('at least one uid is required')
      const add = (Array.isArray(args.add) ? args.add : []).map((value) => String(value)).filter((value) => value !== '')
      const remove = (Array.isArray(args.remove) ? args.remove : []).map((value) => String(value)).filter((value) => value !== '')
      if (add.length === 0 && remove.length === 0) throw new Error('provide at least one of add or remove')
      const mailbox = typeof args.mailbox === 'string' && args.mailbox.trim() !== '' ? args.mailbox.trim() : ALL_MAIL

      return withImap(config, async (client) => {
        await client.storeLabels(uids, '+', add, { mailbox })
        await client.storeLabels(uids, '-', remove, { mailbox })
        const labels = await client.labelsOf(uids[0], { mailbox })
        return { updated: uids, added: add, removed: remove, labels_now: labels }
      })
    },
  })

  tools.push({
    name: 'gmail_archive',
    description:
      'Archive messages by uid: removes them from the inbox while keeping them in All Mail. This is the Gmail-native "archive" action. This is a write operation.',
    parameters: {
      uids: { type: 'array', items: { type: 'string' }, required: true, description: 'Message uids to archive.' },
      mailbox: MAILBOX_PARAM,
    },
    output: jsonOutput(),
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args) {
      checkWrite(config, 'archive mail')
      const uids = (Array.isArray(args.uids) ? args.uids : []).map((value) => String(value).trim()).filter(Boolean)
      if (uids.length === 0) throw new Error('at least one uid is required')
      const mailbox = typeof args.mailbox === 'string' && args.mailbox.trim() !== '' ? args.mailbox.trim() : ALL_MAIL

      return withImap(config, async (client) => {
        const archived = []
        const unchanged = []
        for (const uid of uids) {
          const before = await client.labelsOf(uid, { mailbox })
          if (!before.some((label) => label.toLowerCase() === '\\inbox')) {
            unchanged.push(uid)
            continue
          }
          await client.storeLabels([uid], '-', ['\\Inbox'], { mailbox })
          let after = await client.labelsOf(uid, { mailbox })
          if (after.some((label) => label.toLowerCase() === '\\inbox')) {
            // Fallback: copy to All Mail first, then delete from the inbox.
            await client.copy(uid, ALL_MAIL)
            await client.storeFlags([uid], '+', ['\\Deleted'], { mailbox: 'INBOX' })
            await client.expunge({ mailbox: 'INBOX' })
            after = await client.labelsOf(uid, { mailbox })
          }
          if (after.some((label) => label.toLowerCase() === '\\inbox')) {
            throw new Error(`uid ${uid} is still in the inbox after archiving, stopping to avoid accidental deletion`)
          }
          archived.push(uid)
        }
        return { archived, already_out_of_inbox: unchanged }
      })
    },
  })

  // --------------------------------------------------------------- incremental

  tools.push({
    name: 'gmail_new',
    description:
      'Return only the messages that arrived since the previous call: a durable "what is new" cursor kept in a state file, keyed by the query. Call it repeatedly to poll for new mail without re-reading the same messages. First call returns the current newest messages as a baseline.',
    parameters: {
      query: { type: 'string', description: 'Optional Gmail search query to narrow the watch (e.g. "is:unread in:inbox").' },
      mailbox: MAILBOX_PARAM,
      limit: { type: 'number', description: 'Maximum new messages to return (default 25).' },
      reset: { type: 'boolean', description: 'Forget the stored cursor and treat the current newest message as the baseline.' },
      preview: { type: 'boolean', description: 'Include a body snippet (default true).' },
    },
    output: jsonOutput(),
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const mailbox = typeof args.mailbox === 'string' && args.mailbox.trim() !== '' ? args.mailbox.trim() : ALL_MAIL
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const limit = Math.min(Math.max(1, Math.trunc(Number(args.limit) || 25)), config.maxResultsLimit)
      const key = `${mailbox}\u0000${query}`

      return withImap(config, async (client) => {
        const state = readState(config)
        const previous = args.reset === true ? 0 : Number(state[key] ?? 0)
        const uids = await client.search({ raw: query, mailbox })
        const highest = uids.length > 0 ? Number(uids[0]) : previous
        const fresh = uids.filter((uid) => Number(uid) > previous).slice(0, limit)
        const firstRun = previous === 0
        const entries = await collect(fresh, {
          mailbox,
          preview: args.preview !== false,
          previewLimit: 5,
          exec,
          maxPreviewChars: 300,
        })
        state[key] = Math.max(previous, highest)
        writeState(config, state)
        return {
          baseline: firstRun,
          since_uid: previous,
          highest_uid: state[key],
          count: entries.length,
          messages: entries,
        }
      })
    },
  })

  return { tools }
}
