import type { RawSpan } from './spans.ts';

/**
 * A synthetic dashboard request with problems planted on purpose:
 * an N+1 (12 identical stat lookups) and a render that is mostly waiting.
 * Used until packages/capture can record a real Next.js app.
 */
const MS = 1e6;

interface Planned {
  id: string;
  parent?: string;
  name: string;
  from: number;
  to: number;
  attributes: Record<string, string | number>;
}

export function dashboardTrace(run: number, jitter = 0.08): RawSpan[] {
  const traceId = `trace-${String(run).padStart(3, '0')}`;
  // Deterministic pseudo-random so runs differ but tests stay reproducible.
  let seed = run * 9301 + 49297;
  const wobble = (): number => {
    seed = (seed * 9301 + 49297) % 233280;
    return 1 + ((seed / 233280) * 2 - 1) * jitter;
  };

  const planned: Planned[] = [];
  const push = (p: Planned): Planned => { planned.push(p); return p; };

  push({
    id: 'root', name: 'GET /dashboard', from: 0, to: 2400,
    attributes: { 'http.request.method': 'GET', 'http.route': '/dashboard', 'url.path': '/dashboard' },
  });

  push({
    id: 'page', parent: 'root', name: 'next.render DashboardPage', from: 10, to: 2395,
    attributes: {
      'vibez.component': 'DashboardPage',
      'code.filepath': 'app/dashboard/page.tsx', 'code.lineno': 42, 'code.function': 'DashboardPage',
      'vibez.dataIn': 'req:Object', 'vibez.dataOut': 'userId:String',
    },
  });

  push({
    id: 'list', parent: 'page', name: 'prisma:query', from: 25, to: 120,
    attributes: {
      'db.system': 'postgresql',
      'db.statement': 'SELECT id, name FROM "User" WHERE "orgId" = $1',
      'code.filepath': 'lib/db/queries.ts', 'code.lineno': 70, 'code.function': 'listCustomers',
      'vibez.dataIn': 'orgId:String', 'vibez.dataOut': 'users:List',
    },
  });

  // The planted N+1: one lookup per customer, strictly sequential.
  let cursor = 130;
  for (let i = 0; i < 12; i++) {
    const span = 172;
    push({
      id: `stat-${i}`, parent: 'page', name: 'prisma:query', from: cursor, to: cursor + span,
      attributes: {
        'db.system': 'postgresql',
        'db.statement': `SELECT * FROM "Stat" WHERE "userId" = ${1000 + i}`,
        'code.filepath': 'lib/db/queries.ts', 'code.lineno': 88, 'code.function': 'getUserStats',
        'vibez.dataIn': 'userId:String', 'vibez.dataOut': 'rows:List',
      },
    });
    cursor += span + 3;
  }

  push({
    id: 'billing', parent: 'page', name: 'prisma:query', from: cursor + 5, to: cursor + 85,
    attributes: {
      'db.system': 'postgresql',
      'db.statement': 'SELECT * FROM "Plan" WHERE "orgId" = $1 LIMIT 1',
      'code.filepath': 'lib/db/queries.ts', 'code.lineno': 140, 'code.function': 'getBilling',
      'vibez.dataIn': 'userId:String', 'vibez.dataOut': 'plan:Object',
    },
  });

  push({
    id: 'grid', parent: 'page', name: 'next.render StatsGrid', from: 2330, to: 2390,
    attributes: {
      'vibez.component': 'StatsGrid',
      'code.filepath': 'components/StatsGrid.tsx', 'code.lineno': 8, 'code.function': 'StatsGrid',
      'vibez.dataIn': 'stats:List', 'vibez.dataOut': 'html:Object',
    },
  });

  const scale = wobble();
  return planned.map((p) => ({
    traceId,
    spanId: `${traceId}-${p.id}`,
    ...(p.parent === undefined ? {} : { parentSpanId: `${traceId}-${p.parent}` }),
    name: p.name,
    startNs: Math.round(p.from * scale * MS),
    endNs: Math.round(p.to * scale * MS),
    attributes: p.attributes,
  }));
}

export function dashboardRuns(count = 14): RawSpan[] {
  return Array.from({ length: count }, (_, i) => dashboardTrace(i + 1)).flat();
}
