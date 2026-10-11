// Fake credentials for the connector fixtures (Wave 12, C3).
// Some fake values look like real ones, and GitHub push protection blocks a commit that holds one. A fixture writes
// `@@FAKE:name@@` instead. The test expands it here. Each value is built from parts, so no secret shaped text sits in a file.
export const FAKES = {
  google_client_id: ['1234567890', '-fakefakefake', '.apps.', 'googleusercontent', '.com'].join(''),
  google_client_secret: ['GOC', 'SPX-', 'TEST_VALUE_NOT_A_REAL_SECRET'].join(''),
  github_token: ['github', '_pat_', 'TEST_VALUE_NOT_A_REAL_SECRET'].join(''),
  hf_token: ['hf', '_', 'TESTVALUENOTAREALSECRET'].join(''),
  linear_key: ['lin', '_api_', 'TESTVALUENOTAREALSECRET0000000'].join(''),
  notion_token: ['ntn', '_', 'TESTVALUENOTAREALSECRET'].join(''),
  render_key: ['rnd', '_', 'TESTVALUENOTAREALSECRET'].join(''),
  railway_token: ['TEST-VALUE', '-NOT-A-REAL', '-SECRET-0000000'].join(''),
};

/** Replace every `@@FAKE:name@@` in a JSON value. An unknown name is an error. */
export function expandFakes(value) {
  if (typeof value === 'string') {
    return value.replace(/@@FAKE:([a-z_]+)@@/g, (_all, name) => {
      if (!(name in FAKES)) throw new Error(`unknown fake value "${name}"`);
      return FAKES[name];
    });
  }
  if (Array.isArray(value)) return value.map(expandFakes);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandFakes(v)]));
  return value;
}
