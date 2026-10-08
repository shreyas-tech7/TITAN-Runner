/**
 * @file The route table (Wave 12, S1). Every route has a group. The group decides which token opens it.
 *
 *   public    no token
 *   admin     the admin token, header X-Titan-Auth (people)
 *   internal  the callback token, header X-Titan-Callback (workflows). The admin token works only in legacy mode.
 *   mcp       an MCP token, header Authorization: Bearer (tools).
 *   hook      the secret of one hook (inbound webhooks and the Telegram webhook).
 *   oauth     the redirect of an OAuth provider, checked by its `state` value.
 *
 * docs/RUNTIME.md holds the same table in words. `test/routes.test.mjs` fails if a route has no group.
 */
import { handleCallbackState, handleInternalPing, handleRotateCallback, handleStartPing } from './callback.js';
import {
  handleAdminDiagnose, handleAdminOsintIngest, handleGeospatialEvents, handleGevJwks, handleGevToken, handleInternalGeospatialEvent,
  handleInternalLearningPath, handleInternalSystemMemory, handleInternalVmStatus, handleListVms, handleOsintInvestigate, handleOsintTools,
  handleProvisionVm, handleSystemMemory,
} from './legacy.js';
import {
  handleApprovals, handleCalls, handleCatalog, handleConnect, handleConnectionDetail, handleDecide, handleDisconnect, handleEvents, handleHookRotate, handleInternalCall, handleInternalConnectors, handleInternalEvent,
  handleMcpTokenCreate, handleMcpTokenRevoke, handleMcpTokens, handleNotifyTest, handleOAuthBegin, handleOAuthCallback, handleRename, handleRuleDelete, handleRulePreset, handleRuleSave, handleRules, handleRunAction,
  handleSetPolicy, handleTelegramPair, handleTelegramUnpair, handleTestConnection, handleToolRisk,
} from './connectors/api.js';
import { handleInboundHook } from './connectors/hooks.js';
import { handleTelegramUpdate } from './connectors/telegram.js';
import { handleMcp, handleMcpGet } from './mcpServer.js';
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

  // admin: the connector hub (Wave 12, C3 to C8, M2)
  { method: 'GET', path: '/connectors', group: 'admin', handler: handleCatalog },
  { method: 'POST', path: '/connectors/:id/connect', group: 'admin', handler: handleConnect },
  { method: 'GET', path: '/connections/:cid', group: 'admin', handler: handleConnectionDetail },
  { method: 'POST', path: '/connections/:cid/test', group: 'admin', handler: handleTestConnection },
  { method: 'POST', path: '/connections/:cid/rename', group: 'admin', handler: handleRename },
  { method: 'POST', path: '/connections/:cid/disconnect', group: 'admin', handler: handleDisconnect },
  { method: 'POST', path: '/connections/:cid/policy', group: 'admin', handler: handleSetPolicy },
  { method: 'GET', path: '/connections/:cid/calls', group: 'admin', handler: handleCalls },
  { method: 'POST', path: '/connections/:cid/actions/:actionId', group: 'admin', handler: handleRunAction },
  { method: 'POST', path: '/connections/:cid/telegram/pair', group: 'admin', handler: handleTelegramPair },
  { method: 'POST', path: '/connections/:cid/telegram/unpair', group: 'admin', handler: handleTelegramUnpair },
  { method: 'POST', path: '/connections/:cid/hook/rotate', group: 'admin', handler: handleHookRotate },
  { method: 'POST', path: '/connections/:cid/tools/:name/risk', group: 'admin', handler: handleToolRisk },
  { method: 'POST', path: '/oauth/:connectorId/begin', group: 'admin', handler: handleOAuthBegin },
  { method: 'GET', path: '/approvals', group: 'admin', handler: handleApprovals },
  { method: 'POST', path: '/approvals/:id/approve', group: 'admin', handler: handleDecide('approve') },
  { method: 'POST', path: '/approvals/:id/deny', group: 'admin', handler: handleDecide('deny') },
  { method: 'GET', path: '/admin/mcp/tokens', group: 'admin', handler: handleMcpTokens },
  { method: 'POST', path: '/admin/mcp/tokens', group: 'admin', handler: handleMcpTokenCreate },
  { method: 'DELETE', path: '/admin/mcp/tokens/:id', group: 'admin', handler: handleMcpTokenRevoke },
  { method: 'GET', path: '/admin/notify/rules', group: 'admin', handler: handleRules },
  { method: 'POST', path: '/admin/notify/rules', group: 'admin', handler: handleRuleSave },
  { method: 'DELETE', path: '/admin/notify/rules/:id', group: 'admin', handler: handleRuleDelete },
  { method: 'POST', path: '/admin/notify/preset', group: 'admin', handler: handleRulePreset },
  { method: 'POST', path: '/admin/notify/test', group: 'admin', handler: handleNotifyTest },
  { method: 'GET', path: '/admin/events', group: 'admin', handler: handleEvents },

  // mcp: tools with an MCP token. The handler checks the token itself.
  { method: 'POST', path: '/mcp', group: 'mcp', handler: handleMcp },
  { method: 'GET', path: '/mcp', group: 'mcp', handler: handleMcpGet },

  // hook: the secret of one hook. A browser never calls these routes.
  { method: 'POST', path: '/hooks/:hookId', group: 'hook', handler: handleInboundHook },
  { method: 'POST', path: '/hooks/telegram/:connectionId', group: 'hook', handler: handleTelegramUpdate },

  // oauth: the redirect of an OAuth provider, checked by its state value
  { method: 'GET', path: '/oauth/:connectorId/callback', group: 'oauth', handler: handleOAuthCallback },

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
  { method: 'POST', path: '/internal/event', group: 'internal', handler: handleInternalEvent },
  { method: 'GET', path: '/internal/connectors', group: 'internal', handler: handleInternalConnectors },
  { method: 'POST', path: '/internal/connector-call', group: 'internal', handler: handleInternalCall },
];

// A route that exists only when TITAN_TEST_MODE is set. It measures the sealed box inside the real Workers runtime (K12).
// The deployed Worker never sets the flag, so the route answers 404 there.
ROUTES.push({
  method: 'POST', path: '/admin/_bench/seal', group: 'admin',
  handler: async (c) => {
    if (c.env.TITAN_TEST_MODE !== '1') return json({ error: 'not found' }, 404);
    const { sealWithNacl, sealWithWebCrypto } = await import('./lib/sealedbox.js');
    const body = await c.request.json().catch(() => ({}));
    const n = Math.min(Math.max(Number(body.iterations) || 1, 1), 300);
    const recipient = crypto.getRandomValues(new Uint8Array(32));
    const message = new TextEncoder().encode('x'.repeat(40));
    // Timers stand still inside a Worker request, so the caller times the whole request from outside.
    for (let i = 0; i < n; i += 1) {
      if (body.path === 'nacl') sealWithNacl(message, recipient);
      else await sealWithWebCrypto(message, recipient);
    }
    return json({ path: body.path === 'nacl' ? 'nacl' : 'webcrypto', iterations: n });
  },
});

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
