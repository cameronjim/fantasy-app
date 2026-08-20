import type { QueryResult, QueryResultRow, FieldDef } from 'pg';

export function pgResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    command: '',
    oid: 0,
    fields: [] as FieldDef[],
  };
}

export function pgUniqueViolation(detail = 'duplicate key value'): Error & { code: string; detail: string } {
  const err = new Error('unique constraint violated') as Error & { code: string; detail: string };
  err.code = '23505';
  err.detail = detail;
  return err;
}
