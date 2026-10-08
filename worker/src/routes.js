/**
 * @file The route table (Wave 12, S1). Every route has a group. The group decides which token opens it.
 *
 *   public    no token
 *   admin     the admin token, header X-Titan-Auth (people)
 *   internal  the callback token, header X-Titan-Callback (workflows). The admin token works only in legacy mode.
 *   mcp       an MCP token, header Authorization: Bearer (tools). Release 2.
 *   hook      the secret of one hook (inbound webhooks). Release 2.
 *   oauth     the redirect of an OAuth provider, checked by its `state` value. Release 2.
 *
 * docs/RUNTIME.md holds the same table in words. `test/routes.test.mjs` fails if a route has no group.
 */
import { handleCallbackState, handleInternalPing, handleRotateCallback, handleStartPing } from './callback.js';
import {
  handleAdminDiagnose, handleAdminOsintIngest, handleGeospatialEvents, handleGevJwks, handleGevToken, handleInternalGeospatialEvent,
  handleInternalLearningPath, handleInternalSystemMemory, handleInternalVmStatus, handleListVms, handleOsintInvestigate, handleOsintTools,
  handleProvisionVm, handleSystemMemory,
} from './legacy.js';
import { handleKeyEvents, handleListKeys, handleProviderProof, handleRemoveKey, handleSaveKey, handleSecretRoundTrip, handleTestKey } from './keys.js';
import { handlePulseBadge, handlePulseHeartbeat, handlePulseState, handleRunPulseNow } from './keeper.js';
import { SCHEMA_VERSION } from './lib/migrate.js';
import { json } from './lib/util.js';
import { handleDeleteArea, handleExport } from './retention.js';
import { handleCreateTask, handleInternalStatus, handleRetryTask, handleStatus } from './tasks.js';

/** @typedef {{ method: string, path: string, group: 'public'|'admin'|'internal'|'mcp'|'hook'|'oauth', handler: (c: any) => Response|Promise<Response> }} Route */

/** @type {Route[]} */
export const ROUTES = [
  // public
  { method: 'GET', path: '/', group: 'public', handler: () => json({ ok: true, service: 'titan-runner-brain' }) },
  {
    method: 'GET', path: '/version', group: 'public',
    handler: (c) => json({ service: 'titan-runner-brain', commit: c.env.TITAN_COMMIT || 'unknown', builtAt: c.env.TITAN_BUILD_TIME || null, schemaVersion: SCHEMA_VERSION }),
  },
  { method: 'GET', path: '/gev/jwks', group: 'public', handler: (c) => handleGevJwks(c.env) },
  { method: 'GET', path: '/badge/pulse', group: 'public', handler: (c) => handlePulseBadge(c.env) },

  // admin: people, through the dashboard
  { method: 'GET', path: '/status', group: 'admin', handler: (c) => handleStatus(c.env) },
  { method: 'POST', path: '/tasks', group: 'admin', handler: (c) => handleCreateTask(c.request, c.env) },
  { method: 'POST', path: '/tasks/:id/retry', group: 'admin', handler: (c) => handleRetryTask(c, c.params.id) },
  { method: 'GET', path: '/admin/keys', group: 'admin', handler: handleListKeys },
  { method: 'POST', path: '/admin/keys', group: 'admin', handler: handleSaveKey },
  { method: 'GET', path: '/admin/keys/events', group: 'admin', handler: handleKeyEvents },
  { method: 'DELETE', path: '/admin/keys/:provider', group: 'admin', handler: (c) => handleRemoveKey(c, c.params.provider) },
  { method: 'POST', path: '/admin/keys/:provider/test', group: 'admin', handler: (c) => handleTestKey(c, c.params.provider) },
  { method: 'GET', path: '/admin/diagnose', group: 'admin', handler: (c) => handleAdminDiagnose(c.env) },
  { method: 'POST', path: '/admin/diagnose/secret-roundtrip', group: 'admin', handler: handleSecretRoundTrip },
  { method: 'GET', path: '/admin/callback', group: 'admin', handler: handleCallbackState },
  { method: 'POST', path: '/admin/callback-token/rotate', group: 'admin', handler: handleRotateCallback },
  { method: 'POST', path: '/admin/callback-ping', group: 'admin', handler: handleStartPing },
  { method: 'GET', path: '/admin/pulse', group: 'admin', handler: handlePulseState },
  { method: 'POST', path: '/admin/pulse/run', group: 'admin', handler: handleRunPulseNow },
  { method: 'GET', path: '/admin/export', group: 'admin', handler: handleExport },
  { method: 'POST', path: '/admin/delete-area', group: 'admin', handler: handleDeleteArea },
  { method: 'GET', path: '/gev/token', group: 'admin', handler: (c) => handleGevToken(c.env) },
  { method: 'POST', path: '/admin/osint/ingest', group: 'admin', handler: (c) => handleAdminOsintIngest(c.env) },
  { method: 'GET', path: '/osint/tools', group: 'admin', handler: (c) => handleOsintTools(c.request, c.env) },
  { method: 'POST', path: '/osint/investigate', group: 'admin', handler: (c) => handleOsintInvestigate(c.request, c.env) },
  { method: 'GET', path: '/geospatial/events', group: 'admin', handler: (c) => handleGeospatialEvents(c.env) },
  { method: 'GET', path: '/system-memory', group: 'admin', handler: (c) => handleSystemMemory(c.env) },
  { method: 'GET', path: '/vms', group: 'admin', handler: (c) => handleListVms(c.env) },
  { method: 'POST', path: '/vms/provision', group: 'admin', handler: (c) => handleProvisionVm(c.request, c.env) },

  // internal: workflows, with the callback token
  { method: 'POST', path: '/internal/status', group: 'internal', handler: (c) => handleInternalStatus(c.request, c.env) },
  { method: 'POST', path: '/internal/vm-status', group: 'internal', handler: (c) => handleInternalVmStatus(c.request, c.env) },
  { method: 'POST', path: '/internal/geospatial-event', group: 'internal', handler: (c) => handleInternalGeospatialEvent(c.request, c.env) },
  { method: 'POST', path: '/internal/learning-path', group: 'internal', handler: (c) => handleInternalLearningPath(c.request, c.env) },
  { method: 'POST', path: '/internal/system-memory', group: 'internal', handler: (c) => handleInternalSystemMemory(c.request, c.env) },
  { method: 'GET', path: '/internal/system-memory', group: 'internal', handler: (c) => handleSystemMemory(c.env) },
  { method: 'POST', path: '/internal/provider-proof', group: 'internal', handler: handleProviderProof },
  { method: 'POST', path: '/internal/pulse-heartbeat', group: 'internal', handler: handlePulseHeartbeat },
  { method: 'POST', path: '/internal/ping', group: 'internal', handler: handleInternalPing },
];

const compiled = ROUTES.map((route) => ({ route, parts: route.path.split('/').filter(Boolean) }));

/** @returns {{ route: Route, params: Record<string,string> } | null} */
export function matchRoute(method, pathname) {
  const segments = pathname.split('/').filter(Boolean);
  for (const { route, parts } of compiled) {
    if (route.method !== method || parts.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
      else if (parts[i] !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/** The group of a path for any method. A preflight uses it to pick the CORS rules. */
export function groupForPath(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  for (const { route, parts } of compiled) {
    if (parts.length === segments.length && parts.every((p, i) => p.startsWith(':') || p === segments[i])) return route.group;
  }
  return null;
}
