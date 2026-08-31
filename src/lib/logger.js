/**
 * @file A pulse is a few minutes of a GitHub Actions job log — there is no
 * dashboard tailing a log file, no log rotation, no level filtering to
 * configure. This is a thin, structured console logger, nothing more.
 *
 * Never pass raw secrets or full prompt/response text to this — callers are
 * expected to have already redacted anything sensitive (see lib/redact.js);
 * this module does not redact on your behalf.
 */
function line(level, scope, message, meta) {
  const entry = { ts: new Date().toISOString(), level, scope, message, ...(meta ? { meta } : {}) };
  const text = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

export function createLogger(scope) {
  return {
    debug: (message, meta) => line('debug', scope, message, meta),
    info: (message, meta) => line('info', scope, message, meta),
    warn: (message, meta) => line('warn', scope, message, meta),
    error: (message, meta) => line('error', scope, message, meta),
  };
}

export default createLogger;
