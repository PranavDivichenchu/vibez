import { DatabaseSync } from 'node:sqlite';
import { span } from './tracing.ts';

/**
 * A local SQLite query returns in microseconds, which would make an N+1 look
 * free. ROUND_TRIP_MS stands in for the network hop to a real database — the
 * thing that actually makes N+1 expensive. Tune with SHOP_DB_LATENCY.
 */
const ROUND_TRIP_MS = Number(process.env['SHOP_DB_LATENCY'] ?? 14);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const db = new DatabaseSync(':memory:');

export function seed(customers = 12): void {
  db.exec(`
    CREATE TABLE Org  (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE User (id INTEGER PRIMARY KEY, orgId INTEGER, name TEXT);
    CREATE TABLE Stat (id INTEGER PRIMARY KEY, userId INTEGER, orders INTEGER, value INTEGER, lastSeen TEXT);
    CREATE TABLE Plan (id INTEGER PRIMARY KEY, orgId INTEGER, tier TEXT, renewsOn TEXT);
  `);
  db.prepare('INSERT INTO Org VALUES (?, ?)').run(1, 'Northwind');
  db.prepare('INSERT INTO Plan VALUES (?, ?, ?, ?)').run(1, 1, 'Pro', '2026-10-12');
  const names = ['Acme Supply', 'Brightline', 'Cobalt Foods', 'Delta Works', 'Everly Group',
    'Fairhaven', 'Grindstone', 'Harborview', 'Ironwood', 'Juniper Co', 'Keystone', 'Lantern Bay'];
  for (let i = 0; i < customers; i++) {
    db.prepare('INSERT INTO User VALUES (?, ?, ?)').run(i + 1, 1, names[i % names.length]);
    db.prepare('INSERT INTO Stat VALUES (?, ?, ?, ?, ?)')
      .run(i + 1, i + 1, 9 + ((i * 7) % 40), 2000 + i * 913, '2 hours ago');
  }
}

async function query<T>(
  sql: string,
  params: Array<string | number>,
  where: { file: string; line: number; fn: string },
  ports: { in?: string; out?: string } = {},
  selector?: string,
  extraLatencyMs = 0,
): Promise<T[]> {
  return span('sqlite:query', {
    'db.system': 'sqlite',
    'db.statement': sql,
    'code.filepath': where.file,
    'code.lineno': where.line,
    'code.function': where.fn,
    ...(ports.in === undefined ? {} : { 'vibez.dataIn': ports.in }),
    ...(ports.out === undefined ? {} : { 'vibez.dataOut': ports.out }),
    ...(selector === undefined ? {} : { 'vibez.selector': selector }),
  }, async () => {
    await wait(ROUND_TRIP_MS + extraLatencyMs);
    return db.prepare(sql).all(...params) as T[];
  });
}

export interface Customer { id: number; name: string }
export interface Stat { orders: number; value: number; lastSeen: string }
export interface Plan { tier: string; renewsOn: string }

export const listCustomers = (orgId: number): Promise<Customer[]> =>
  query('SELECT id, name FROM User WHERE orgId = ?', [orgId],
    { file: 'examples/shop/src/db.ts', line: 58, fn: 'listCustomers' },
    { in: 'orgId:Number', out: 'users:List' }, '.tiles');

/**
 * One round trip for every customer's stats, returned in the same order as
 * the customers passed in.
 */
export async function getUserStats(customers: Customer[]): Promise<Stat[]> {
  if (customers.length === 0) return [];
  const ids = customers.map((c) => c.id);
  const rows = await query<Stat & { userId: number }>(
    `SELECT userId, orders, value, lastSeen FROM Stat WHERE userId IN (${ids.map(() => '?').join(', ')})`, ids,
    { file: 'examples/shop/src/db.ts', line: 71, fn: 'getUserStats' },
    { in: 'userIds:List', out: 'rows:List' }, 'tbody');
  const byUser = new Map<number, Stat>();
  for (const { userId, ...stat } of rows) if (!byUser.has(userId)) byUser.set(userId, stat);
  return ids.flatMap((id) => byUser.get(id) ?? []);
}

export const getBilling = (orgId: number): Promise<Plan | undefined> =>
  query<Plan>('SELECT tier, renewsOn FROM Plan WHERE orgId = ? LIMIT 1', [orgId],
    { file: 'examples/shop/src/db.ts', line: 80, fn: 'getBilling' },
    { in: 'orgId:Number', out: 'plan:Object' }, '.plan-chip').then((rows) => rows[0]);

export interface Alert { level: string; message: string }
export interface Order { id: number; customer: string; total: number }

/**
 * Two slower lookups with nothing in common, planted for the drag.
 *
 * They run one after another in server.ts even though neither needs the
 * other. Dragging one node onto the other in Vibez merges them into a single
 * Promise.all, and the dashboard gets about 60 ms faster.
 */
export const getAlerts = (orgId: number): Promise<Alert[]> =>
  query<Alert>("SELECT 'warning' AS level, 'Card on file expires next month' AS message WHERE ? > 0", [orgId],
    { file: 'examples/shop/src/db.ts', line: 108, fn: 'getAlerts' },
    { in: 'orgId:Number', out: 'alerts:List' }, '.alert', 46);

export const getRecentOrders = (orgId: number): Promise<Order[]> =>
  query<Order>(
    "SELECT u.id AS id, u.name AS customer, s.value AS total FROM User u JOIN Stat s ON s.userId = u.id WHERE u.orgId = ? ORDER BY s.value DESC LIMIT 4",
    [orgId],
    { file: 'examples/shop/src/db.ts', line: 113, fn: 'getRecentOrders' },
    { in: 'orgId:Number', out: 'orders:List' }, '.orders', 46);

export interface Offer { title: string; detail: string }

/**
 * The two sides of the planted if/else. Northwind is on Pro, so only the
 * renewal offer ever runs; Vibez reads the other side from the source and
 * shows it as a step that never ran.
 */
export const getRenewalOffer = (orgId: number): Promise<Offer | undefined> =>
  query<Offer>("SELECT 'Renew early' AS title, 'Lock in this year''s price before 12 Oct.' AS detail WHERE ? > 0", [orgId],
    { file: 'examples/shop/src/db.ts', line: 134, fn: 'getRenewalOffer' },
    { in: 'orgId:Number', out: 'offer:Object' }, '.offer').then((rows) => rows[0]);

export const getUpgradeOffer = (orgId: number): Promise<Offer | undefined> =>
  query<Offer>("SELECT 'Try Pro free' AS title, 'Unlimited seats for 14 days.' AS detail WHERE ? > 0", [orgId],
    { file: 'examples/shop/src/db.ts', line: 140, fn: 'getUpgradeOffer' },
    { in: 'orgId:Number', out: 'offer:Object' }, '.offer').then((rows) => rows[0]);
