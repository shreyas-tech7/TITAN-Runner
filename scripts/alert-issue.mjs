#!/usr/bin/env node
/**
 * @file Opens or closes an alert Issue from a workflow (RT3, RO5). It uses the gated GitHub client, so the text is
 * cleaned and only the allowed labels work. Replaces `actions/github-script`.
 *
 *   node scripts/alert-issue.mjs open  --label titan-alert --title "..." --body "..."
 *   node scripts/alert-issue.mjs close --label titan-alert --title "..." --comment "..."
 *
 * Needs GITHUB_TOKEN and GITHUB_REPOSITORY. Exit code 0 on success or when there is nothing to do.
 */
import { createGitHubClient } from '../src/github.js';
import { ensureAlert, resolveAlert } from '../src/ops/alerts.js';

const args = process.argv.slice(2);
const verb = args[0];
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

async function main() {
  const label = flag('--label');
  const title = flag('--title');
  if (!['open', 'close'].includes(verb) || !label || !title) {
    console.error('usage: alert-issue.mjs open|close --label <label> --title <title> [--body <text> | --comment <text>]');
    return 2;
  }
  const github = createGitHubClient({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY });
  if (!github.ready()) {
    console.error('alert-issue: set GITHUB_TOKEN and GITHUB_REPOSITORY.');
    return 2;
  }
  if (verb === 'open') {
    const res = await ensureAlert(github, { label, title, body: flag('--body') ?? '' });
    console.log(`alert-issue: ${res.action}${res.number ? ` #${res.number}` : ''}`);
  } else {
    const res = await resolveAlert(github, { label, title, comment: flag('--comment') ?? 'Resolved.' });
    console.log(`alert-issue: ${res.action}${res.number ? ` #${res.number}` : ''}`);
  }
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`alert-issue: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
