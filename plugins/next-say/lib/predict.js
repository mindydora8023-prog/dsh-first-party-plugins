/**
 * Pure prompt-prediction logic for dsh-plugin-next-say.
 *
 * Everything in this module is deterministic and side-effect free, so the whole
 * decision surface (what we send, how long, which language, how we clean up the
 * reply) is unit-testable without a Host, a model, or a session.
 *
 * Source is kept pure ASCII on purpose (workspace convention). User-visible
 * text lives in the locale dictionaries; language names here are values sent to
 * the model, not UI copy.
 */

/** Characters per token, conservative, used to derive a token safety net. */
const CHARS_PER_TOKEN_CJK = 0.6;
const CHARS_PER_TOKEN_LATIN = 2.5;

/**
 * Extra room so a reasoning model cannot eat the whole visible budget.
 *
 * This was 256 and that is the value that makes the plugin look "DeepSeek only":
 * a reasoning model answers nothing until its thinking is done, so a budget of
 * "text + 256" can be spent entirely on reasoning, the stream ends with
 * `max-tokens` and no text, and the plugin reports `truncated` -- which is silent,
 * so a non-reasoning provider seems to work and a reasoning one seems unsupported.
 *
 * `maxTokens` is a CAP, not a charge: unused room costs nothing. Keeping this
 * generous is therefore nearly free and removes a whole class of
 * provider-dependent failure.
 */
const REASONING_HEADROOM_TOKENS = 640;

/** Token cap bounds. Wide enough for a short sentence, narrow enough to bound cost. */
const MIN_TOKEN_CAP = 256;
const MAX_TOKEN_CAP = 2048;

/** Languages written without spaces between words (character-counted). */
const CJK_NAME = /Chinese|Japanese|Korean/i;

/**
 * Material that is QUOTED rather than written: a pasted URL, a fenced block, an
 * inline code span. It names the topic of the message, not the language the
 * message is written in, so it must not vote on that language.
 *
 * Measured origin of this rule: the first user message of a real session was a
 * GitHub link followed immediately by a Chinese sentence asking what could be
 * borrowed from that project for one of our plugins. The Latin characters (URL
 * plus two package names) outnumbered its Han characters, so it was classified
 * Latin. The vote had exactly one ballot, the prompt said "Write it in English",
 * and the suggestion for a Chinese conversation came back in English.
 *
 * The URL class is URL-safe ASCII rather than `\S+`: CJK text is regularly typed
 * against a link with no space between them (link then the sentence, no break),
 * and `\S+` swallowed the whole request from there on -- leaving no prose at all
 * to classify.
 */
const QUOTED_MATERIAL = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\b(?:https?|ftp|file):\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/gi;

/**
 * Script probes, ordered so a script that borrows another's block is checked
 * first. Kana and Hangul contain few Han characters, so they rarely collide.
 *
 * Units are comparable, not raw characters: a script that separates words counts
 * WORDS, every other script counts characters. One Latin letter is a fragment of
 * a word while one Han character is a whole morpheme, so counting characters for
 * both gives Latin a five-fold head start on every identifier or URL it quotes.
 */
const SCRIPT_PROBES = Object.freeze([
  ['Japanese', /[\u3040-\u30ff\u31f0-\u31ff]/g],
  ['Korean', /[\uac00-\ud7af\u1100-\u11ff]/g],
  ['Chinese', /[\u4e00-\u9fff]/g],
  ['Russian', /[\u0400-\u04ff]/g],
  ['Arabic', /[\u0600-\u06ff\u0750-\u077f]/g],
  ['Hebrew', /[\u0590-\u05ff]/g],
  ['Devanagari', /[\u0900-\u097f]/g],
  ['Thai', /[\u0e00-\u0e7f]/g],
  ['Greek', /[\u0370-\u03ff]/g],
  // Whole word runs, not single letters: see the units note above.
  ['Latin', /[A-Za-z\u00c0-\u024f]+/g],
]);

/** Pairs languages with the written form named in the prompt. */
const SCRIPT_TO_LANGUAGE = Object.freeze({
  Japanese: 'Japanese',
  Korean: 'Korean',
  Chinese: 'Simplified Chinese',
  Russian: 'Russian',
  Arabic: 'Arabic',
  Hebrew: 'Hebrew',
  Devanagari: 'Hindi',
  Thai: 'Thai',
  Greek: 'Greek',
  Latin: 'English',
});

/**
 * Traditional-character fingerprints. A Chinese passage containing several of
 * these is written in Traditional script, and asking for "Chinese" would let
 * the model mix glyph sets, so the prompt names the script explicitly.
 *
 * Escaped rather than literal: these are algorithm data, but this workspace
 * keeps executable sources ASCII so a console encoding round-trip can never
 * corrupt a source file.
 */
const TRADITIONAL_MARKS = '\u5011\u500b\u9019\u4f86\u8aaa\u6642\u6703\u5c0d\u958b\u95dc\u5be6\u9ede\u70ba\u8207\u5b78\u570b\u8a9e\u8eca\u6771\u9577\u9580\u554f\u9593\u6a23\u9032\u9084\u904b';

/** Weight per mark; a handful of these is already decisive. */
function traditionalScore(text) {
  let score = 0;
  for (const char of text) {
    if (TRADITIONAL_MARKS.includes(char)) score += 1;
  }
  return score;
}

/**
 * What is left of a message once quoted material is removed.
 *
 * Exported because the voting step needs the same notion: a message that was
 * nothing but a link or a code block carries no language signal at all and must
 * not cast a ballot (an all-URL message used to vote English).
 */
export function proseOf(text) {
  return (typeof text === 'string' ? text : '').replace(QUOTED_MATERIAL, ' ');
}

/**
 * Pick the script with the largest share of the message; default Latin.
 *
 * Two rules make this usable on coding conversations, and both were missing:
 * quoted material does not vote (see `QUOTED_MATERIAL`), and a Latin word counts
 * once while a Han character counts once. Without them a Chinese request that
 * names a URL and two packages was read as English.
 */
export function detectScript(text) {
  const input = proseOf(text);
  if (input.trim() === '') return 'Latin';
  let best = 'Latin';
  let bestCount = 0;
  for (const [script, pattern] of SCRIPT_PROBES) {
    const count = (input.match(pattern) ?? []).length;
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Language label for the prompt.
 *
 * Votes per message rather than per character: one pasted English log must not
 * outvote the conversation it was pasted into. Ties resolve to the later
 * message, which is the one being continued.
 */
export function detectConversationLanguage(history, sample = 5) {
  // A message with no prose (a bare link, a pasted block) has no language to
  // vote with. It used to vote Latin, which is how one link could decide that a
  // Chinese conversation wanted its suggestion in English.
  const items = (Array.isArray(history) ? history : [])
    .filter((item) => item && typeof item.text === 'string' && proseOf(item.text).trim() !== '');
  if (items.length === 0) return 'English';
  const users = items.filter((item) => item.role === 'user');
  const pool = (users.length > 0 ? users : items).slice(-sample);

  const votes = new Map();
  const scripts = [];
  for (const item of pool) {
    const script = detectScript(item.text);
    scripts.push(script);
    votes.set(script, (votes.get(script) ?? 0) + 1);
  }

  let best = 'Latin';
  let bestCount = -1;
  for (let index = 0; index < pool.length; index += 1) {
    const script = scripts[index];
    const count = votes.get(script) ?? 0;
    if (count >= bestCount) {
      best = script;
      bestCount = count;
    }
  }

  if (best === 'Chinese') {
    const combined = pool.map((item) => item.text).join('\n');
    return traditionalScore(combined) >= 4 ? 'Traditional Chinese' : 'Simplified Chinese';
  }
  return SCRIPT_TO_LANGUAGE[best] ?? 'English';
}

/** Whether a language name is counted in characters rather than words. */
export function isCharacterCounted(language) {
  return CJK_NAME.test(String(language ?? ''));
}

/**
 * Convert the user-facing character limit into a token safety net.
 *
 * The user sets characters because both they and the model understand them; the
 * token cap only exists to bound a runaway reply. It is deliberately generous.
 */
export function charsToTokens(chars, language) {
  const want = Number(chars);
  if (!Number.isFinite(want) || want <= 0) return MIN_TOKEN_CAP;
  const perToken = isCharacterCounted(language) ? CHARS_PER_TOKEN_CJK : CHARS_PER_TOKEN_LATIN;
  const textTokens = Math.ceil(want / perToken);
  return Math.min(MAX_TOKEN_CAP, Math.max(MIN_TOKEN_CAP, textTokens + REASONING_HEADROOM_TOKENS));
}

/** The instructions sent as the system prompt. */
export function buildSystemPrompt(language, budgetChars) {
  const budget = Number(budgetChars) > 0 ? Math.round(Number(budgetChars)) : 60;
  const languageName = String(language ?? '').trim() || 'the same language as the conversation';
  return [
    'You draft the next message the user will send in an ongoing conversation with a coding agent.',
    '',
    'Rules:',
    '1. Output one message the user could send as-is. No explanation, no quotes, no "Suggestion:" prefix, no markdown fence.',
    `2. Write it in ${languageName}, using the standard written form of that language. Use the script that language names: Traditional Chinese means Traditional characters.`,
    '3. Move the work forward: prefer the next step the assistant just finished or proposed.',
    '4. Do not repeat the assistant\'s last sentence and do not invent goals the user never expressed.',
    `5. Keep it to one short sentence, at most about ${budget} characters. A complete short sentence beats a truncated longer one.`,
    '6. If nothing sensible should follow, output nothing at all.',
  ].join('\n');
}

/** Extract only plain text from a message's content blocks. */
export function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  const parts = [];
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text !== '') parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

/** Keep the tail of an over-long message, where the live context is. */
function tailOf(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, 1) === '\n' ? '' : '...'}\n${text.slice(-limit)}`;
}

/**
 * Whether a message was written by the human.
 *
 * The harness also files INJECTED material as `role: 'user'`: runtime context, the
 * skill catalogue, AGENTS.md instructions and time snapshots all arrive as user
 * messages, each with a `source.kind` naming its origin (verified against a real
 * session log: `runtime-context`, `skill-catalog`, `agent-instructions`,
 * `time-context`). Only `source.kind === 'user'` is the human.
 *
 * Skipping this check has two consequences, both bad: the transcript sent to the
 * model is mostly boilerplate, and history completion can never match the user's
 * own words because the pool is full of injected context instead.
 */
export function isUserAuthored(message) {
  const source = message === null || message === undefined ? undefined : message.source;
  if (source === undefined || source === null) return true;
  if (typeof source !== 'object') return true;
  return source.kind === undefined || source.kind === 'user';
}

/**
 * Select the most recent user/assistant plain text, newest first, under a
 * character budget.
 *
 * Tool output, attachments, system prompts, injected context and hidden reasoning
 * never enter the auxiliary call: they are neither this plugin's material nor
 * cheap to send.
 */
export function recentMessages(messages, options = {}) {
  const maxMessages = Number.isFinite(options.maxMessages) ? Math.max(1, Math.floor(options.maxMessages)) : 8;
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(0, Math.floor(options.maxChars)) : 6000;
  const perMessageChars = Number.isFinite(options.perMessageChars)
    ? Math.max(80, Math.floor(options.perMessageChars))
    : 1600;

  const candidates = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    // Injected user-role messages are not the conversation.
    if (message.role === 'user' && !isUserAuthored(message)) continue;
    const text = messageText(message);
    if (text === '') continue;
    candidates.push({ role: message.role, text: tailOf(text, perMessageChars) });
  }

  const kept = [];
  let used = 0;
  for (let index = candidates.length - 1; index >= 0 && kept.length < maxMessages; index -= 1) {
    const item = candidates[index];
    // The separator and role label are part of what we actually send.
    const cost = item.text.length + 32;
    // Always keep the newest qualifying message: a single huge message must not
    // empty the whole transcript.
    if (kept.length > 0 && used + cost > maxChars) break;
    kept.unshift(item);
    used += cost;
  }
  return kept;
}

/**
 * Two-round dedupe key: case, whitespace, paired quotes and the trailing
 * sentence mark carry no meaning when asking "is this the same suggestion".
 */
export function dedupeKey(text) {
  let out = String(text ?? '').trim().toLowerCase();
  out = out.replace(/[\s\u3000]+/g, '');
  out = out.replace(/^["'\u201c\u2018\u300c\u300e]+|["'\u201d\u2019\u300d\u300f]+$/g, '');
  out = out.replace(/[.?!\u3002\uff1f\uff01,;\uff0c\uff1b:\uff1a]+$/g, '');
  return out;
}

/** Levenshtein distance, capped: only small distances are interesting here. */
export function editDistance(a, b, cap = 3) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > cap) return cap + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > cap) return cap + 1;
    previous = current;
  }
  return previous[right.length];
}

/**
 * Whether a fresh suggestion is effectively the one the user already saw.
 *
 * Re-showing a reworded duplicate is worse than showing nothing: it looks like
 * the feature is stuck, and it invites a real second model call to fix it.
 */
export function isNearDuplicate(next, previous) {
  const a = dedupeKey(next);
  const b = dedupeKey(previous);
  if (a === '' || b === '') return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 8) return false;
  return editDistance(a, b, 2) <= 2;
}

const WRAPPER_PREFIX = /^(?:```[a-z0-9_-]*\s*|`)/i;
const WRAPPER_SUFFIX = /(?:\s*```|`)$/;
/**
 * Labels a model likes to prepend, in the languages this plugin predicts in.
 * The trailing separator may be an ASCII colon or its full-width form, which is
 * what a Chinese or Japanese reply actually uses.
 */
const LABEL_PREFIX = /^(?:suggestion|prediction|next message|next say|predicted message|you might say|the user might say|answer|\u5efa\u8bae|\u9884\u6d4b|\u4e0b\u4e00\u6761(?:\u6d88\u606f|\u63d0\u793a\u8bcd)?|\u56de\u7b54|\u63a8\u8350|\u63d0\u6848|\uacf5\uac04|\uc81c\uc548)\s*[:\uff1a]\s*/iu;
const QUOTE_TRIMMED = /^["'\u201c\u2018\u300c\u300e\u00ab]+|["'\u201d\u2019\u300d\u300f\u00bb]+$/gu;

/**
 * Turn raw model output into one line a user could actually send.
 *
 * Bounded twice: the caller's character limit, and the wrapper/label stripping
 * above. Returning an empty string is a valid outcome and the caller treats it
 * as "no suggestion", never as an error.
 */
export function normalizeSuggestion(raw, maxChars = 400) {
  let text = String(raw ?? '');
  if (text.trim() === '') return '';

  text = text.trim();
  // A fenced block: keep what is inside, drop the fence itself.
  const fence = /^```[a-z0-9_-]*\s*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fence !== null) text = fence[1];
  text = text.replace(WRAPPER_PREFIX, '').replace(WRAPPER_SUFFIX, '');
  text = text.replace(LABEL_PREFIX, '');
  text = text.trim();

  // One line only: a multi-line answer is a reply, not a next message.
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  text = lines.join(' ');

  text = text.replace(QUOTE_TRIMMED, '').trim();
  text = text.replace(/[\s\u3000]+/g, ' ').trim();

  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 400;
  if (text.length > limit) {
    // Cut at a word boundary when there is one near the limit.
    const window = text.slice(0, limit);
    const boundary = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\u3001'), window.lastIndexOf('\uff0c'));
    text = (boundary > limit * 0.6 ? window.slice(0, boundary) : window).trim();
  }
  return text;
}

/** The framing turn sent as the only message of the auxiliary call. */
export function buildRequestText(history, language, options = {}) {
  const framed = history
    .map((item) => `[${item.role === 'user' ? 'User' : 'Assistant'}]\n${item.text}`)
    .join('\n\n');
  const parts = [
    'Conversation so far:',
    '',
    framed,
    '',
    `Draft the user's next message in ${language}. Output that message only.`,
  ];
  const avoid = typeof options.avoid === 'string' ? options.avoid.trim().slice(0, 200) : '';
  if (avoid !== '') {
    parts.push(
      '',
      options.forceDifferent === true
        ? `The user already saw this and asked for a DIFFERENT message (do not repeat it, do not just change punctuation):\n${avoid}`
        : `This message was already shown and may still be the best next one; reuse it only if nothing newer fits better:\n${avoid}`,
    );
  }
  return parts.join('\n');
}

/**
 * Resolve the model route for one session: the session's own last-used model
 * wins, and the global default is only a fallback.
 */
export function resolveRoute(session, fallbackSelection) {
  try {
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined;
    const config = header?.config;
    if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model };
    }
  } catch {
    // A session without a request header yet falls through to the default.
  }
  const selection = fallbackSelection;
  if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
    return { provider: selection.provider, model: selection.model };
  }
  return undefined;
}

/**
 * Bounded LRU of the last suggestion per session, so "give me a different one"
 * and near-duplicate filtering do not need unbounded memory.
 */
export function createSuggestionMemory(limit = 100) {
  const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
  const entries = new Map();
  return {
    get(sessionId) {
      return entries.get(sessionId);
    },
    set(sessionId, value) {
      if (value === undefined || value === null || value === '') {
        entries.delete(sessionId);
        return;
      }
      // Re-inserting keeps insertion order aligned with recency.
      entries.delete(sessionId);
      entries.set(sessionId, value);
      while (entries.size > size) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    delete(sessionId) {
      entries.delete(sessionId);
    },
    size() {
      return entries.size;
    },
  };
}
