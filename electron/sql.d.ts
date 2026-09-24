// Lets esbuild's `text` loader import .sql files as strings (see scripts/build-electron.mjs).
declare module '*.sql' {
  const sql: string;
  export default sql;
}
