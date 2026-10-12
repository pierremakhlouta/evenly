import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderSqlVectorTests, SQL_TESTS_PATH, VECTORS_PATH } from '../scripts/sql-vectors';

describe('generated pgTAP vector tests', () => {
  it('are up to date with shared/test-vectors.json (run npm run gen:sql-vectors)', () => {
    const expected = renderSqlVectorTests(readFileSync(VECTORS_PATH, 'utf8'));
    expect(readFileSync(SQL_TESTS_PATH, 'utf8')).toBe(expected);
  });
});
