/**
 * A small Supabase client over plain fetch: sign in, refresh, and the
 * PostgREST calls the team feature needs. No SDK, so the same file runs in
 * the MCP server, the CLI and (synced) the IDE's main process.
 */

export class TeamError extends Error {}

export interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

export type Query = Record<string, string | undefined>;

interface AuthReply {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
  user?: { id: string };
}

export class SupabaseRest {
  readonly url: string;
  private readonly anonKey: string;
  private session: Session | undefined;
  /** Called whenever the session is created or refreshed, so it can be saved. */
  private readonly onSession: ((session: Session) => void) | undefined;

  constructor(url: string, anonKey: string, session?: Session, onSession?: (session: Session) => void) {
    this.url = url.replace(/\/+$/, '');
    this.anonKey = anonKey;
    this.session = session;
    this.onSession = onSession;
  }

  get userId(): string | undefined {
    return this.session?.userId;
  }

  private toSession(reply: AuthReply): Session {
    const userId = reply.user?.id ?? this.session?.userId;
    if (!reply.access_token || !reply.refresh_token || !userId) throw new TeamError('Supabase did not return a session.');
    const session: Session = {
      accessToken: reply.access_token,
      refreshToken: reply.refresh_token,
      userId,
      expiresAt: reply.expires_at ?? Math.floor(Date.now() / 1000) + (reply.expires_in ?? 3600),
    };
    this.session = session;
    this.onSession?.(session);
    return session;
  }

  private async auth(path: string, body: unknown): Promise<AuthReply> {
    const response = await fetch(`${this.url}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: this.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const message = String(data['msg'] ?? data['error_description'] ?? data['message'] ?? response.statusText);
      if (/anonymous sign-ins are disabled/i.test(message)) {
        throw new TeamError('This Supabase project does not allow anonymous sign-ins. Turn them on under Authentication → Sign In / Providers.');
      }
      throw new TeamError(`Sign-in failed: ${message}`);
    }
    return data as unknown as AuthReply;
  }

  /** A new anonymous user: nothing to type, and the session is kept on this machine. */
  async signInAnonymously(): Promise<Session> {
    return this.toSession(await this.auth('signup', { data: {} }));
  }

  async refresh(): Promise<Session> {
    if (!this.session) throw new TeamError('Not signed in.');
    return this.toSession(await this.auth('token?grant_type=refresh_token', { refresh_token: this.session.refreshToken }));
  }

  /** A current access token, refreshed if it is about to expire: for opening a live connection. */
  accessToken(): Promise<string> {
    return this.token();
  }

  get anon(): string {
    return this.anonKey;
  }

  private async token(): Promise<string> {
    if (!this.session) throw new TeamError('Not signed in to the team. Run: npm run team -- join <code> --as <your name>');
    if (this.session.expiresAt - 60 < Date.now() / 1000) await this.refresh();
    return this.session!.accessToken;
  }

  private async request<T>(method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
    const headers: Record<string, string> = {
      apikey: this.anonKey,
      authorization: `Bearer ${await this.token()}`,
      'content-type': 'application/json',
    };
    if (prefer) headers['prefer'] = prefer;
    let response: Response;
    try {
      response = await fetch(`${this.url}/rest/v1/${path}`, { method, headers, body: body === undefined ? null : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      throw new TeamError(`Could not reach the team server at ${this.url}: ${(error as Error).message}`);
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) as unknown : undefined;
    if (!response.ok) {
      const d = (data ?? {}) as Record<string, unknown>;
      throw new TeamError(String(d['message'] ?? d['hint'] ?? response.statusText));
    }
    return data as T;
  }

  private static qs(query: Query): string {
    const parts = Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`);
    return parts.length ? `?${parts.join('&')}` : '';
  }

  select<T>(table: string, query: Query = {}): Promise<T[]> {
    return this.request<T[]>('GET', `${table}${SupabaseRest.qs(query)}`);
  }

  async insert<T>(table: string, rows: object | object[]): Promise<T[]> {
    return this.request<T[]>('POST', table, rows, 'return=representation');
  }

  update<T>(table: string, filter: Query, patch: object): Promise<T[]> {
    return this.request<T[]>('PATCH', `${table}${SupabaseRest.qs(filter)}`, patch, 'return=representation');
  }

  rpc<T>(fn: string, args: object): Promise<T> {
    return this.request<T>('POST', `rpc/${fn}`, args);
  }
}
