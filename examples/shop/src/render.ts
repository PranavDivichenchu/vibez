import { span } from './tracing.ts';
import type { Customer, Plan, Stat } from './db.ts';

const money = (n: number): string => `$${n.toLocaleString('en-US')}`;

export const StatsGrid = (customers: Customer[], stats: Stat[]): Promise<string> =>
  span('render StatsGrid', {
    'vibez.component': 'StatsGrid',
    'code.filepath': 'examples/shop/src/render.ts',
    'code.lineno': 8,
    'code.function': 'StatsGrid',
    'vibez.dataIn': 'stats:List',
    'vibez.dataOut': 'html:Object',
  }, async () => {
    const rows = customers.map((customer, i) => {
      const stat = stats[i];
      return `<tr><td>${customer.name}</td><td>${stat?.orders ?? 0}</td>` +
        `<td>${stat?.lastSeen ?? ''}</td><td>${money(stat?.value ?? 0)}</td></tr>`;
    });
    return `<table><tbody>${rows.join('')}</tbody></table>`;
  });

export const DashboardPage = (
  body: () => Promise<{ grid: string; plan: Plan | undefined }>,
): Promise<string> =>
  span('render DashboardPage', {
    'vibez.component': 'DashboardPage',
    'code.filepath': 'examples/shop/src/render.ts',
    'code.lineno': 27,
    'code.function': 'DashboardPage',
    'vibez.dataIn': 'req:Object',
    'vibez.dataOut': 'orgId:Number',
  }, async () => {
    const { grid, plan } = await body();
    return `<!doctype html><title>Dashboard</title>` +
      `<h1>Dashboard</h1><span class="plan">${plan?.tier ?? 'Free'} plan</span>${grid}`;
  });
