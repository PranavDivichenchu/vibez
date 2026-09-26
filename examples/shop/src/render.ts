import { span } from './tracing.ts';
import type { Customer, Plan, Stat } from './db.ts';

const money = (n: number): string => `$${n.toLocaleString('en-US')}`;

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  color:#1A1A19;background:#F5F5F3;-webkit-font-smoothing:antialiased}
.shell{display:flex;min-height:100vh}
.side{width:212px;flex:none;min-width:0;background:#fff;border-right:1px solid #E4E4E1;padding:22px 16px}
.brand{display:flex;align-items:center;gap:9px;margin-bottom:26px;font-size:15px;font-weight:600}
.brand i{width:22px;height:22px;border-radius:6px;background:#1A1A19;display:block}
.nav a{display:block;padding:8px 11px;border-radius:7px;margin-bottom:2px;color:#6B6B67;text-decoration:none}
.nav a.on{background:#F0F0ED;color:#1A1A19;font-weight:500}
.main{flex:1;padding:28px 34px;min-width:0}
.top{display:flex;align-items:center;margin-bottom:22px}
h1{margin:0;font-size:25px;font-weight:600;letter-spacing:-.02em;flex:1}
.plan-chip{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid #E4E4E1;
  border-radius:999px;padding:7px 15px;font-size:13px}
.plan-chip i{width:7px;height:7px;border-radius:50%;background:#2D7D6E;display:block}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:22px}
.tile{background:#fff;border:1px solid #E4E4E1;border-radius:10px;padding:14px 16px}
.tile .k{font-size:12px;color:#6B6B67;margin-bottom:6px}
.tile .v{font-size:23px;font-weight:600;letter-spacing:-.02em}
.card{background:#fff;border:1px solid #E4E4E1;border-radius:10px;overflow:hidden}
.card h2{margin:0;padding:14px 18px;font-size:15px;font-weight:600;border-bottom:1px solid #E4E4E1}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:12px;font-weight:400;color:#6B6B67;padding:10px 18px;border-bottom:1px solid #EFEFEC}
td{padding:12px 18px;font-size:13.5px;border-bottom:1px solid #F2F2EF}
tbody tr:last-child td{border-bottom:0}
td:first-child{font-weight:500}
td:nth-child(3){color:#6B6B67}
@media (max-width:760px){.side{display:none}.main{padding:20px}}
`;

export const StatsGrid = (customers: Customer[], stats: Stat[]): Promise<string> =>
  span('render StatsGrid', {
    'vibez.component': 'StatsGrid',
    'code.filepath': 'examples/shop/src/render.ts',
    'code.lineno': 48,
    'code.function': 'StatsGrid',
    'vibez.selector': '.card',
    'vibez.dataIn': 'rows:List',
    'vibez.dataOut': 'html:Object',
  }, async () => {
    const rows = customers.map((customer, i) => {
      const stat = stats[i];
      return `<tr><td>${customer.name}</td><td>${stat?.orders ?? 0}</td>` +
        `<td>${stat?.lastSeen ?? ''}</td><td>${money(stat?.value ?? 0)}</td></tr>`;
    }).join('');
    return `<section class="card"><h2>Customer activity</h2><table>
      <thead><tr><th>Customer</th><th>Orders</th><th>Last seen</th><th>Value</th></tr></thead>
      <tbody>${rows}</tbody></table></section>`;
  });

export const DashboardPage = (
  body: () => Promise<{ grid: string; plan: Plan | undefined; count: number; value: number }>,
): Promise<string> =>
  span('render DashboardPage', {
    'vibez.component': 'DashboardPage',
    'code.filepath': 'examples/shop/src/render.ts',
    'code.lineno': 68,
    'code.function': 'DashboardPage',
    'vibez.dataIn': 'req:Object',
    'vibez.dataOut': 'orgId:Number',
  }, async () => {
    const { grid, plan, count, value } = await body();
    const nav = ['Dashboard', 'Orders', 'Customers', 'Products', 'Settings']
      .map((item, i) => `<a href="#" class="${i === 0 ? 'on' : ''}">${item}</a>`).join('');
    const tile = (k: string, v: string) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Dashboard — Northwind</title><style>${STYLE}</style></head><body>
<div class="shell">
  <aside class="side"><div class="brand"><i></i>Northwind</div><nav class="nav">${nav}</nav></aside>
  <main class="main">
    <div class="top"><h1>Dashboard</h1>
      <span class="plan-chip"><i></i>${plan?.tier ?? 'Free'} plan &middot; renews ${plan?.renewsOn ?? '—'}</span></div>
    <div class="tiles">${tile('Customers', String(count))}${tile('Orders this week', '312')}${tile('Revenue', money(value))}${tile('Refunds', '7')}</div>
    ${grid}
  </main>
</div></body></html>`;
  });
