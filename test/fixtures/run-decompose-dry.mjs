// Fixture for decomposer.test.js: run in a child process (with
// TITAN_DRY_RUN=1 already set in the env before node starts) so config.js's
// import-time freeze actually observes it, then print the resulting graph
// as JSON for the parent test to assert on.
import { decompose } from '../../src/orchestrator/decomposer.js';

const graph = await decompose('anything, this is ignored in dry-run mode');
process.stdout.write(JSON.stringify(graph));
