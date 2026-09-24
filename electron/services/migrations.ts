// Ordered, append-only list of schema migrations. Version N is applied when the
// database's PRAGMA user_version is < N. Never edit or reorder a released entry;
// add a new database/migrations/NNN_*.sql file and append it here instead.
import schemaV1 from '../../database/schema.sql';
import routingLogV2 from '../../database/migrations/002_routing_log.sql';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'baseline schema', sql: schemaV1 },
  { version: 2, name: 'routing log', sql: routingLogV2 },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
