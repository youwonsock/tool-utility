import test from 'node:test';
import assert from 'node:assert/strict';
import { codexToml } from '../dist/index.mjs';
import { configFixture, decodeInlineToml, hookKey } from './codex-toml-fixture.mjs';
test('Codex TOML preserves exact keys, trusted hashes and values without raw CMD operators', () => {
  const encoded = codexToml(configFixture);
  assert.doesNotMatch(encoded, /[<>&|%^!()]/);
  const decoded = decodeInlineToml(encoded);
  assert.deepEqual(decoded, configFixture);
  assert.equal(decoded.state[hookKey].trusted_hash, configFixture.state[hookKey].trusted_hash);
  assert.deepEqual(decodeInlineToml(codexToml({ empty: undefined, nil: null, ok: [] })), { ok: [] });
});
