import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize } from '../scripts/ci-check.mjs';

test('CI diagnostics redact multiline credentials, native auth, URI userinfo and environment values',()=>{
  const secret='explicit-environment-credential';
  const result=sanitize(`failure\nAuthorization: Bearer abc.def\npassword = "native-password"\nhttps://user:pass@example.invalid/x\nBasic dXNlcjpwYXNz\nsecret_0123456789abcdef0123456789abcdef\n${secret}\n-----BEGIN RSA PRIVATE KEY-----\nsecret-lines\n-----END RSA PRIVATE KEY-----\nstack: src/scope.ts:42`,{TEST_TOKEN:secret});
  for(const value of ['abc.def','native-password','user:pass','dXNlcjpwYXNz','0123456789abcdef','secret-lines',secret])assert.equal(result.includes(value),false,value);
  assert.match(result,/failure/);assert.match(result,/src\/scope\.ts:42/);
});

test('CI diagnostics redact a private key truncated by the bounded capture before its END marker',()=>{
  const result=sanitize('decisive failure\n-----BEGIN PRIVATE KEY-----\ntruncated-base64-key-material');
  assert.match(result,/decisive failure/);assert.equal(result.includes('truncated-base64-key-material'),false);assert.equal(result.includes('BEGIN PRIVATE KEY'),false);
});
