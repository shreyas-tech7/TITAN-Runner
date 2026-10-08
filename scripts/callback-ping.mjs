#!/usr/bin/env node
/**
 * @file The runner side of the callback round trip test (Wave 12, K8). It calls `POST /internal/ping` with the callback
 * token. The exit code is 1 when the Worker does not take the call, so the run shows red when the callback path is broken.
 */
import { callWorker } from '../src/lib/workerCallback.js';

const id = (process.env.TITAN_PING_ID ?? '').trim() || `manual_${process.env.GITHUB_RUN_ID ?? 'local'}`;
if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
  console.error('callback-ping: the ping id has a character that is not allowed.');
  process.exit(1);
}
const res = await callWorker('/internal/ping', { body: { id } });
if (res.ok) {
  console.log(`callback-ping: the Worker took the ping with the ${res.json?.authKind ?? res.kind} token.`);
  if (res.kind === 'admin') console.log('::warning::This run used the admin token. The callback token is empty or missing in the repo secrets.');
} else {
  console.error(`callback-ping: the Worker did not take the ping (status ${res.status ?? 'none'}${res.error ? `, ${res.error}` : ''}).`);
  process.exit(1);
}
