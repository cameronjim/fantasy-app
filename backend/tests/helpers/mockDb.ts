import type { QueryResult, QueryResultRow, FieldDef } from 'pg';

// test-only `pg.QueryResult` shim. only `rows` and `rowCount` are populated —
// the other fields exist because the QueryResult type requires them, but
// routes never read them.
export function pgResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    command: '',
    oid: 0,
    fields: [] as FieldDef[],
  };
}

// pg's "unique_violation" error shape so routes that branch on
// `err.code === '23505'` can be exercised without a real db.
export function pgUniqueViolation(detail = 'duplicate key value'): Error & { code: string; detail: string } {
  const err = new Error('unique constraint violated') as Error & { code: string; detail: string };
  err.code = '23505';
  err.detail = detail;
  return err;
}
