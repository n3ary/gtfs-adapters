// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Severity-tagged reconcile warnings.
 *
 * Each warning is a `{ severity, message }` object. The severity is
 * decided at the source (where the warning is emitted) — never guessed
 * at render time. This means:
 *   - adding a new warning site never silently flips a tier
 *   - there's a single source of truth (the call site itself)
 *   - the regex pattern lists that used to live here are gone
 *
 * Severity rules of thumb (for callers):
 *   - INFO  : we resolved the data successfully, just noting what we did
 *             (e.g. "merged N", "using default", "added N from Tranzy")
 *   - WARN  : data was lost or unverified (e.g. "skipped", "0 trips",
 *             "DO NOT MATCH", "CSV missing")
 *   - ERROR : build cannot continue safely (rare — only true stop-the-line
 *             cases; almost everything is WARN today)
 *
 * If unsure: WARN. The safe default for "we don't know what we don't
 * know" is to surface it loudly.
 */

export const SEVERITY = Object.freeze({
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
});

/**
 * ANSI color codes. GitHub Actions renders these in the web console
 * (and `script` blocks in workflow steps honor them). In a non-TTY
 * (e.g. when piped to a file) the colors still show as escape codes
 * — that's the trade-off for cross-platform support.
 */
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/**
 * GitHub Actions workflow commands. The opener/closer must be on
 * their own lines; GH Actions strips them into a click-to-expand
 * section in the web console. Outside GH Actions (local runs) these
 * are harmless noise.
 */
const GHA = {
  groupOpen: (name) => `::group::${name}`,
  groupClose: () => '::endgroup::',
};

/**
 * Build a tagged warning object. Use this helper at call sites so
 * the API stays consistent — never construct `{severity, message}`
 * literals inline.
 *
 * Pass an optional `meta` object to attach side-channel data
 * (e.g. `{ route: '57', directionReversed: true }`). Downstream tools
 * can `warnings.filter(w => w.meta?.directionReversed)` to grep the
 * side-channel without parsing message text.
 *
 * @param {'info' | 'warn' | 'error'} severity
 * @param {string} message
 * @param {Record<string, unknown> | null} [meta]
 * @returns {{severity: string, message: string, meta?: Record<string, unknown>}}
 */
export function warn(severity, message, meta = null) {
  return meta == null ? { severity, message } : { severity, message, meta };
}

/** Convenience shortcuts — slightly more readable than `warn(SEVERITY.X, ...)`. */
export const info = (message, meta = null) => warn(SEVERITY.INFO, message, meta);
export const warnMsg = (message, meta = null) => warn(SEVERITY.WARN, message, meta);
export const errorMsg = (message, meta = null) => warn(SEVERITY.ERROR, message, meta);

/**
 * Read the severity off a tagged warning. Replaces the old
 * `classifyWarning(warning)` heuristic that pattern-matched on the
 * message text.
 *
 * @param {{severity: string, message: string}} warning
 * @returns {'info' | 'warn' | 'error'}
 */
export function severityOf(warning) {
  return warning.severity;
}

/**
 * Render a single warning line with a colored severity prefix.
 * Use this when printing warnings one-per-line in the build log.
 *
 * @param {{severity: string, message: string}} warning
 * @returns {string}
 */
export function formatWarningLine(warning) {
  const tag = warning.severity.toUpperCase().padEnd(5);
  const color =
    warning.severity === SEVERITY.INFO ? COLORS.green :
    warning.severity === SEVERITY.ERROR ? COLORS.red :
    COLORS.yellow;
  return `${color}[${tag}]${COLORS.reset} ${warning.message}`;
}

/**
 * Group tagged warnings by severity and emit them under collapsible
 * GHA sections. Returns the counts for the summary line.
 *
 * @param {Array<{severity: string, message: string}>} warnings
 * @returns {{info: number, warn: number, error: number}}
 */
export function emitGroupedWarnings(warnings) {
  /** @type {Record<string, Array<{severity: string, message: string}>>} */
  const groups = { info: [], warn: [], error: [] };
  for (const w of warnings) {
    const bucket = groups[w.severity] ?? groups.warn;
    bucket.push(w);
  }
  if (groups.info.length > 0) {
    console.log(GHA.groupOpen(`\x1b[32mINFO\x1b[0m: ${groups.info.length} reconcile note(s) — data resolved successfully`));
    for (const w of groups.info) console.log(`  ${formatWarningLine(w)}`);
    console.log(GHA.groupClose());
  }
  if (groups.warn.length > 0) {
    console.log(GHA.groupOpen(`\x1b[33mWARN\x1b[0m: ${groups.warn.length} data-loss signal(s) — review before merging`));
    for (const w of groups.warn) console.log(`  ${formatWarningLine(w)}`);
    console.log(GHA.groupClose());
  }
  if (groups.error.length > 0) {
    console.log(GHA.groupOpen(`\x1b[31mERROR\x1b[0m: ${groups.error.length} stop-the-line signal(s)`));
    for (const w of groups.error) console.log(`  ${formatWarningLine(w)}`);
    console.log(GHA.groupClose());
  }
  return {
    info: groups.info.length,
    warn: groups.warn.length,
    error: groups.error.length,
  };
}