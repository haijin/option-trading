/** Connection-URL helpers for the test harness (admin URL points at the maintenance database). */
export function adminUrl(): string {
  const explicit = process.env.PG_ADMIN_URL;
  if (explicit) return explicit;
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('Set PG_ADMIN_URL (or DATABASE_URL) in .env so tests can create throwaway databases');
  return withDatabase(base, 'postgres');
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
