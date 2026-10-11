#!/usr/bin/env node
/**
 * @file Scaffold a new connector in connectors/<id>/ (Wave 12, C10).
 *
 * Usage:
 *   npm run connectors:new <id> [--dir <connectorsDir>]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function scaffoldConnector(id, baseDir = 'connectors') {
  if (!id || !/^[a-z][a-z0-9_]{1,39}$/.test(id)) {
    throw new Error('The connector id must match ^[a-z][a-z0-9_]{1,39}$, for example my_service.');
  }
  const folder = join(baseDir, id);
  if (existsSync(folder)) {
    throw new Error(`The folder ${folder} already exists.`);
  }
  const title = id
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const icon = id
    .split('_')
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
    .slice(0, 3) || 'CN';
  const host = `api.${id.replace(/_/g, '-')}.example.com`;

  mkdirSync(join(folder, 'fixtures'), { recursive: true });

  const manifest = {
    id,
    name: title,
    icon,
    version: '1.0.0',
    category: 'custom',
    description: `Connect TITAN to ${title}.`,
    docsUrl: `https://${host}/docs`,
    getKeyUrl: `https://${host}/settings/keys`,
    apiVersion: 'v1',
    auth: {
      kind: 'bearer',
      setupNote: `Create a read token in ${title} and paste it here.`,
      fields: [
        {
          name: 'token',
          label: 'API token',
          secret: true,
          help: `Paste the ${title} bearer token.`,
        },
      ],
    },
    egress: [host],
    test: {
      mode: 'request',
      request: {
        method: 'GET',
        url: `https://${host}/v1/status`,
        headers: {
          Authorization: 'Bearer {{secret.token}}',
        },
      },
      expect: {
        status: [200],
        pick: ['status'],
      },
    },
    actions: [
      {
        id: 'status',
        title: 'Get status',
        risk: 'read',
        dataClass: 'internal',
        input: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        request: {
          method: 'GET',
          url: `https://${host}/v1/status`,
          headers: {
            Authorization: 'Bearer {{secret.token}}',
          },
        },
        pick: ['status', 'version'],
        rateLimit: {
          perMinute: 30,
        },
      },
    ],
  };

  const readme = [
    `# ${title} connector`,
    '',
    `This connector links TITAN to ${title}. The Worker keeps the token in the encrypted vault and sends requests through the outbound guard.`,
    '',
    '## Setup steps',
    '',
    `1. Open the ${title} settings page and create an API token with read access.`,
    '2. Open the TITAN Connectors page and select this connector.',
    '3. Paste the token into the API token field and click Connect.',
    '4. Check that the live test passes and returns a status.',
    '',
    '## Actions',
    '',
    '- `status` (`read`, `internal`): Reads the current service status and version.',
    '',
  ].join('\n');

  const testFixture = {
    name: 'test: status check',
    target: 'test',
    connection: {
      config: {},
      secrets: {
        token: 'test',
      },
    },
    input: {},
    expect: {
      request: {
        method: 'GET',
        url: `https://${host}/v1/status`,
        headers: {
          Authorization: ['Bearer', 'test'].join(' '),
        },
        body: null,
      },
      hosts: [],
    },
    response: {
      status: 200,
      contentType: 'application/json',
      body: {
        status: 'ok',
        extra: 'ignored',
      },
    },
    output: {
      status: 'ok',
    },
  };

  const actionFixture = {
    name: 'status: returns status and version',
    target: 'action:status',
    connection: {
      config: {},
      secrets: {
        token: 'test',
      },
    },
    input: {},
    expect: {
      request: {
        method: 'GET',
        url: `https://${host}/v1/status`,
        headers: {
          Authorization: ['Bearer', 'test'].join(' '),
        },
        body: null,
      },
      hosts: [],
    },
    response: {
      status: 200,
      contentType: 'application/json',
      body: {
        status: 'ok',
        version: '1.0.0',
        internal_secret: 'dropped',
      },
    },
    output: {
      status: 'ok',
      version: '1.0.0',
    },
  };

  writeFileSync(join(folder, 'connector.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(folder, 'README.md'), readme);
  writeFileSync(join(folder, 'fixtures', 'test.json'), `${JSON.stringify(testFixture, null, 2)}\n`);
  writeFileSync(join(folder, 'fixtures', 'status.json'), `${JSON.stringify(actionFixture, null, 2)}\n`);
  return { id, folder, host };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const baseDir = dirIdx >= 0 ? args[dirIdx + 1] : 'connectors';
  const id = args.find((a, idx) => !a.startsWith('--') && idx !== dirIdx + 1);
  try {
    const res = scaffoldConnector(id ?? '', baseDir);
    console.log(`connectors:new: created ${res.folder}. Run "npm run connectors:check" after you edit it.`);
  } catch (err) {
    console.error(`connectors:new: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
