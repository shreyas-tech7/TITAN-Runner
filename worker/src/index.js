/**
 * @file titan-runner-brain: the always-on coordinator for the TITAN-Runner sub-agent cluster.
 *
 * A Cloudflare Worker, not a server. It holds no state of its own, because D1 does. It runs no long process and does no
 * heavy work. Each tick reads and writes a few D1 rows and makes a few GitHub calls, then hands real work to a GitHub
 * Actions runner through `repository_dispatch`. That keeps it inside the 10 ms CPU budget of the Workers free plan.
 *
 * The Workers runtime accepts a default handler only from this entry module. A named export of any other kind stops the
 * runtime from starting. So every handler lives in its own module, and tests import them from there.
 * The route table is in routes.js. The request pipeline is in app.js. The tick is in tick.js.
 */
import { handleRequest } from './app.js';
import { runSixHourly, runTick } from './tick.js';

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    // Two cron entries share this handler (see wrangler.toml). The 6-hour one runs the meta-agent and the retention rules.
    if (event.cron === '0 */6 * * *') {
      ctx.waitUntil(runSixHourly(env));
      return;
    }
    ctx.waitUntil(runTick(env));
  },
};
