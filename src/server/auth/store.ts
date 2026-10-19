import { and, count, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { appSessions, appUsers, loginLinks } from '../../db/schema';
import { sha256 } from './http';

/** Arbitrary constant naming the "create the first account" critical section. */
const FIRST_USER_LOCK = 7_240_001;

export type UserRow = typeof appUsers.$inferSelect;
export type SessionMethod = 'password' | 'google' | 'email_link' | 'setup';

/** The auth tables, and nothing else: all decisions live in AuthService. */
export class AuthStore {
  constructor(private readonly db: Db) {}

  async userCount(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(appUsers);
    return row?.n ?? 0;
  }

  async byId(id: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(appUsers).where(eq(appUsers.id, id)).limit(1);
    return row ?? null;
  }

  /** Username or email, both stored lower-case. */
  async byIdentifier(identifier: string): Promise<UserRow | null> {
    const key = identifier.trim().toLowerCase();
    const [row] = await this.db
      .select()
      .from(appUsers)
      .where(or(eq(appUsers.username, key), eq(appUsers.email, key)))
      .limit(1);
    return row ?? null;
  }

  async byEmail(email: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(appUsers).where(eq(appUsers.email, email.toLowerCase())).limit(1);
    return row ?? null;
  }

  async byGoogleSub(sub: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(appUsers).where(eq(appUsers.googleSub, sub)).limit(1);
    return row ?? null;
  }

  async usernameTaken(username: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: appUsers.id })
      .from(appUsers)
      .where(eq(appUsers.username, username))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Creates the owner account, or returns null when an account already exists. The check and the insert run under an
   * advisory lock, so two simultaneous "first visits" cannot both become the owner.
   */
  async insertFirstUser(v: {
    username: string;
    email: string;
    passwordHash: string | null;
    googleSub?: string | null;
    emailVerifiedAt: Date | null;
  }): Promise<UserRow | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${FIRST_USER_LOCK})`);
      const [row] = await tx.select({ n: count() }).from(appUsers);
      if ((row?.n ?? 0) > 0) return null;
      const [created] = await tx
        .insert(appUsers)
        .values({
          username: v.username,
          email: v.email,
          passwordHash: v.passwordHash,
          googleSub: v.googleSub ?? null,
          emailVerifiedAt: v.emailVerifiedAt,
        })
        .returning();
      return created as UserRow;
    });
  }

  async patchUser(
    id: string,
    v: Partial<Pick<UserRow, 'googleSub' | 'emailVerifiedAt' | 'lastLoginAt' | 'passwordHash'>>,
  ): Promise<void> {
    await this.db.update(appUsers).set(v).where(eq(appUsers.id, id));
  }

  async createSession(token: string, userId: string, method: SessionMethod, now: Date, ttlMs: number): Promise<void> {
    await this.db
      .insert(appSessions)
      .values({ tokenHash: sha256(token), userId, method, createdAt: now, expiresAt: new Date(now.getTime() + ttlMs) });
    await this.db.delete(appSessions).where(lt(appSessions.expiresAt, now));
  }

  /** The account a live session cookie belongs to, or null (unknown, expired). */
  async userForSession(token: string, now: Date): Promise<UserRow | null> {
    const [row] = await this.db
      .select({ user: appUsers })
      .from(appSessions)
      .innerJoin(appUsers, eq(appUsers.id, appSessions.userId))
      .where(and(eq(appSessions.tokenHash, sha256(token)), gt(appSessions.expiresAt, now)))
      .limit(1);
    return row?.user ?? null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.delete(appSessions).where(eq(appSessions.tokenHash, sha256(token)));
  }

  async deleteSessionsOf(userId: string): Promise<void> {
    await this.db.delete(appSessions).where(eq(appSessions.userId, userId));
  }

  async createLink(token: string, email: string, now: Date, ttlMs: number): Promise<void> {
    await this.db
      .insert(loginLinks)
      .values({ tokenHash: sha256(token), email, createdAt: now, expiresAt: new Date(now.getTime() + ttlMs) });
    await this.db.delete(loginLinks).where(lt(loginLinks.expiresAt, now));
  }

  /** Marks a live, unused link as used and returns its email; null when it is unknown, expired or already used. */
  async consumeLink(token: string, now: Date): Promise<string | null> {
    const [row] = await this.db
      .update(loginLinks)
      .set({ usedAt: now })
      .where(and(eq(loginLinks.tokenHash, sha256(token)), isNull(loginLinks.usedAt), gt(loginLinks.expiresAt, now)))
      .returning({ email: loginLinks.email });
    return row?.email ?? null;
  }
}
