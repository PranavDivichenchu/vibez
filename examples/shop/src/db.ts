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
    await wait(ROUND_TRIP_MS);
    return db.prepare(sql).all(...params) as T[];
  });
}

export interface Customer { id: number; name: string }
export interface Stat { orders: number; value: number; lastSeen: string }
export interface Plan { tier: string; renewsOn: string }

export const listCustomers = (orgId: number): Promise<Customer[]> =>
  query('SELECT id, name FROM User WHERE orgId = ?', [orgId],
    { file: 'examples/shop/src/db.ts', line: 58, fn: 'listCustomers' },
    { in: 'orgId:Number', out: 'users:List' });

/**
 * The planted N+1. One round trip per customer, strictly sequential, which is
 * exactly the shape an ORM produces when you await inside a loop.
 */
export async function getUserStats(customers: Customer[]): Promise<Stat[]> {
  const out: Stat[] = [];
  for (const customer of customers) {
    const [row] = await query<Stat>(
      'SELECT orders, value, lastSeen FROM Stat WHERE userId = ?', [customer.id],
      { file: 'examples/shop/src/db.ts', line: 71, fn: 'getUserStats' },
      { in: 'userId:Number', out: 'rows:List' }, 'tbody');
    if (row) out.push(row);
  }
  return out;
}

export const getBilling = (orgId: number): Promise<Plan | undefined> =>
  query<Plan>('SELECT tier, renewsOn FROM Plan WHERE orgId = ? LIMIT 1', [orgId],
    { file: 'examples/shop/src/db.ts', line: 80, fn: 'getBilling' },
    { in: 'orgId:Number', out: 'plan:Object' }, 'span.plan').then((rows) => rows[0]);
