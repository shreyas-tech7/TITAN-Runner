// Serves a FakeWorld over http on 127.0.0.1, so a Worker that runs in the real workerd can reach the fakes.
// A request to /h/<host>/<path> is the fake of https://<host>/<path>. The Worker gets a TITAN_TEST_HOST_MAP that
// points each real host at its /h/<host> prefix. This works only with TITAN_TEST_MODE=1.
import { createServer } from 'node:http';

export const FAKE_HOSTS = [
  'api.github.com', 'raw.githubusercontent.com', 'api.groq.com', 'api.together.xyz', 'openrouter.ai', 'generativelanguage.googleapis.com',
  'huggingface.co', 'router.huggingface.co', 'llm.example.com', 'gw.example.com', 'hermes.example.com',
];

/** @param {import('./world.mjs').FakeWorld} world */
export async function startFakeServer(world, extraHosts = []) {
  const server = createServer(async (req, res) => {
    try {
      const m = req.url.match(/^\/h\/([^/]+)(\/.*)?$/);
      if (!m) {
        res.writeHead(404).end('not found');
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length > 0 && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'connection', 'content-length'].includes(k)) headers.set(k, v);
      const response = await world.handle(new Request(`https://${m[1]}${m[2] ?? '/'}`, { method: req.method, headers, body }));
      const out = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(out);
    } catch (err) {
      res.writeHead(500).end(String(err?.message ?? err));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const hostMap = Object.fromEntries([...FAKE_HOSTS, ...extraHosts].map((h) => [h, `http://127.0.0.1:${port}/h/${h}`]));
  return { port, hostMap, stop: () => new Promise((resolve) => server.close(resolve)) };
}
