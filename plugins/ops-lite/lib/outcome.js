/**
 * Structured failure vocabulary, adapted from dsh-ops `src/kernel/{outcome,errors}.ts`.
 *
 * The problem this solves: a bare `throw` tells the model "the call failed" and
 * nothing else. For a mutating call that is actively dangerous -- the model
 * cannot tell whether the write landed, so its only recovery is to try again,
 * which may duplicate it. Every ops-lite tool therefore RETURNS a failure
 * record instead of throwing, and the record always answers three questions:
 *
 *   effectState  did the operation change anything?
 *   retry        may the model call again, and after what change?
 *   nextAction   what should it do instead?
 *
 * The single rule that matters: EFFECTS DOMINATE RETRY ADVICE. A call that may
 * have produced an effect never licenses a replay, whatever the error code says.
 * That is enforced in one place (`errorPolicy`) rather than at each call site.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

/** Did the operation change observable state? */
export const EFFECT_STATES = ['none', 'applied', 'partial', 'unknown']

/** May the caller retry, and after what change? */
export const RETRY_POLICIES = ['never', 'after-input-change', 'after-state-change', 'bounded-transient']

/**
 * Build the frozen per-code policy table.
 *
 * `none`/`after-input-change` is the ordinary shape: nothing happened, the
 * arguments were wrong, fix them and call again. Codes whose retry advice
 * differs from their effect class are the interesting entries and each carries
 * a comment saying why.
 */
const policy = (status, retry) => Object.freeze({ status, retry })

const REJECTED = policy('rejected', 'never')
const INVALID = policy('error', 'after-input-change')
const CHANGED = policy('error', 'after-state-change')
const SETTLED = policy('error', 'never')
const UNKNOWN = policy('unknown', 'never')

/**
 * Stable error codes and their retry advice.
 *
 * These names are the model-facing vocabulary; rename one only with a
 * corresponding change to the prompt guidance in `index.js`.
 */
export const ERROR_POLICIES = Object.freeze({
  // The request itself is refused; retrying the same request is always wrong.
  POLICY_DENIED: REJECTED,
  CREDENTIAL_DENIED: REJECTED,
  PATH_RESTRICTED: REJECTED,

  // A stale guard: the file changed underneath us or the caller was looking at
  // an old version. Re-reading first is the whole recovery.
  REVISION_CONFLICT: policy('conflict', 'after-state-change'),
  FS_STALE_VERSION: policy('conflict', 'after-state-change'),

  // Bad or unusable arguments -- nothing was touched.
  INVALID_ARGUMENT: INVALID,
  ARGUMENT_SCHEMA: INVALID,
  NOT_FOUND: INVALID,
  IS_DIRECTORY: INVALID,
  OUTPUT_LIMIT: INVALID,
  BINARY_CONTENT: INVALID,
  ENCODING_ERROR: INVALID,
  OFFSET_OUT_OF_RANGE: INVALID,

  // The target changed in a way the caller must observe before proceeding.
  FILE_CHANGED: CHANGED,
  PATH_CHANGED: CHANGED,
  ACCESS_DENIED: CHANGED,

  // Terminal: repeating the identical call cannot succeed.
  IO_ERROR: SETTLED,
  UNSUPPORTED: SETTLED,
  RESULT_PARTIAL: SETTLED,

  // Transient contention: a bounded number of retries is legitimate.
  JOB_BUSY: policy('error', 'bounded-transient'),

  // The outcome could not be established. Effects dominate, so these are
  // `unknown`/`never` in practice; the entries exist so a lookup is total.
  EXECUTION_RESTRICTED: UNKNOWN,
  RESULT_UNKNOWN: UNKNOWN,
})

/**
 * The retry advice for a failure, with effects taking precedence over the code.
 *
 * A caller that reports `applied`, `partial` or `unknown` never receives a
 * retry-friendly answer: replaying a mutation that may already have happened is
 * exactly the failure mode this module exists to prevent.
 *
 * @param {string} code - a stable error code; unknown codes settle to `never`.
 * @param {string} [effectState] - the reported effect state, default `none`.
 * @returns {{status: string, retry: string}} the frozen policy entry.
 */
export function errorPolicy(code, effectState = 'none') {
  if (effectState === 'unknown' || code === 'RESULT_UNKNOWN' || code === 'EXECUTION_RESTRICTED') return UNKNOWN
  if (effectState !== 'none') return SETTLED
  return Object.prototype.hasOwnProperty.call(ERROR_POLICIES, code) ? ERROR_POLICIES[code] : SETTLED
}

/**
 * Build a failure record. Never throws, and never omits the three answers.
 *
 * @param {string} code - stable error code.
 * @param {object} [details]
 * @param {string} [details.message] - human-readable detail; must not echo secrets.
 * @param {string} [details.effectState] - `none` when omitted (nothing happened).
 * @param {string} [details.nextAction] - the concrete recovery step.
 * @param {string} [details.phase] - which stage failed, for diagnostics.
 * @param {string} [details.reason] - machine-ish cause detail.
 * @returns {object} `{status, error}` with `effectState`, `retry`, `code`.
 */
export function failure(code, details = {}) {
  const effectState = EFFECT_STATES.includes(details.effectState) ? details.effectState : 'none'
  const advice = errorPolicy(code, effectState)
  const error = {
    code,
    effectState,
    retry: advice.retry,
    message: typeof details.message === 'string' && details.message !== '' ? details.message : code,
  }
  if (typeof details.phase === 'string') error.phase = details.phase
  if (typeof details.reason === 'string') error.reason = details.reason
  if (typeof details.nextAction === 'string' && details.nextAction !== '') error.nextAction = details.nextAction
  return { status: advice.status, error }
}

/** Map a host filesystem error code onto this module's vocabulary. */
export const FS_CODE_MAP = Object.freeze({
  FS_NOT_FOUND: 'NOT_FOUND',
  FS_NOT_DIRECTORY: 'IS_DIRECTORY',
  FS_NOT_REGULAR_FILE: 'IS_DIRECTORY',
  FS_NOT_TEXT: 'ENCODING_ERROR',
  FS_TOO_LARGE: 'OUTPUT_LIMIT',
  FS_PERMISSION_DENIED: 'ACCESS_DENIED',
  FS_SANDBOX_DENIED: 'POLICY_DENIED',
  FS_IO_ERROR: 'IO_ERROR',
  FS_STALE_VERSION: 'REVISION_CONFLICT',
  FS_NOT_OBSERVED: 'NOT_FOUND',
  FS_AMBIGUOUS_EDIT: 'INVALID_ARGUMENT',
  FS_EDIT_NOT_FOUND: 'INVALID_ARGUMENT',
  FS_ABORTED: 'RESULT_UNKNOWN',
})

/**
 * Convert a thrown error into a failure record without losing its code.
 *
 * A host `FsError` carries a stable `code`; that code is mapped so the model
 * sees one vocabulary. Anything else becomes `IO_ERROR`, which is `never`
 * retryable -- deliberately conservative, because an unclassified throw from a
 * mutation could have half-applied.
 *
 * @param {unknown} error - the caught value.
 * @param {object} [details] - extra fields merged into the record.
 * @returns {object} a failure record.
 */
export function fromThrown(error, details = {}) {
  const rawCode = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined
  const code = rawCode !== undefined && Object.prototype.hasOwnProperty.call(FS_CODE_MAP, rawCode)
    ? FS_CODE_MAP[rawCode]
    : (rawCode ?? 'IO_ERROR')
  const message = error instanceof Error ? error.message : String(error)
  return failure(code, { ...details, message })
}

/**
 * True when a value is a failure record this module produced.
 * @param {unknown} value - candidate result.
 * @returns {boolean} whether it carries a structured error.
 */
export function isFailure(value) {
  return value !== null && typeof value === 'object' && value.error !== null && typeof value.error === 'object'
    && typeof value.error.code === 'string'
}
