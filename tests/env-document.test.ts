import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectEnvDocument } from '../src/env-document.js';

test('projection preserves ordered duplicates and exact RHS spelling without changing raw bytes', () => {
  const raw = '\uFEFF # fake comment\r\n\r\n export FAKE_A ="fake $REF # literal" # tail\r\nFAKE_EMPTY=\r\nFAKE_A= unquoted # literal $REF\r\n';
  const before = Buffer.from(raw);
  assert.deepEqual(projectEnvDocument(raw), { assignments: [
    { name: 'FAKE_A', value: '"fake $REF # literal" # tail', line: 3 },
    { name: 'FAKE_EMPTY', value: '', line: 4 },
    { name: 'FAKE_A', value: ' unquoted # literal $REF', line: 5 },
  ], incompleteFromLine: null });
  assert.deepEqual(Buffer.from(raw), before);
});

test('single, double and backtick multiline spans consume assignment-looking lines and escaped delimiters', () => {
  for (const quote of ["'", '"', '`']) {
    const value = `${quote}fake\\${quote}\r\nFAKE_NOT_A_KEY=no\r\nend${quote}`;
    assert.deepEqual(projectEnvDocument(`FAKE_MULTI=${value}\r\nFAKE_NEXT=yes\r\n`), {
      assignments: [{ name: 'FAKE_MULTI', value, line: 1 }, { name: 'FAKE_NEXT', value: 'yes', line: 4 }],
      incompleteFromLine: null,
    });
  }
});

test('unsupported or unterminated syntax stops projection conservatively with line numbers only', () => {
  for (const invalid of ['not-a-key=fake-secret', 'FAKE_BAD="fake\nFAKE_INSIDE=secret',
    'FAKE_BAD="fake" trailing', 'FAKE_BAD=some"quote', 'FAKE_BAD=fake\\']) {
    const result = projectEnvDocument(`FAKE_OK=yes\n${invalid}\nFAKE_LATER=no`);
    assert.deepEqual(result, { assignments: [{ name: 'FAKE_OK', value: 'yes', line: 1 }], incompleteFromLine: 2 });
    assert.doesNotMatch(JSON.stringify(result), /fake-secret|FAKE_INSIDE|FAKE_LATER/);
  }
});

test('empty/comment documents, CR endings and a large literal document are supported', () => {
  assert.deepEqual(projectEnvDocument('\uFEFF\t# comment\r\n \t\r'), { assignments: [], incompleteFromLine: null });
  assert.deepEqual(projectEnvDocument('FAKE_A=one\rFAKE_B=two').assignments.map(row => row.line), [1, 2]);
  assert.equal(projectEnvDocument(`FAKE_LONG=${'x'.repeat(1024 * 1024 - 10)}`).assignments.length, 1);
});
