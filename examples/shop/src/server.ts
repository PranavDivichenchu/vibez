import { createServer } from 'node:http';
import { tracer, flush } from './tracing.ts';
import { seed, listCustomers, getUserStats, getBilling } from './db.ts';
import { DashboardPage, StatsGrid } from './render.ts';

seed(12);

const port = Number(process.env['PORT'] ?? 3100);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/dashboard') {
    res.writeHead(404).end('not found');
    return;
  }
  // The root span is the HTTP request, which is what makes this an `entry` node.
  void tracer.startActiveSpan('GET /dashboard', {
    attributes: { 'http.request.method': 'GET', 'http.route': '/dashboard', 'url.path': url.pathname },
  }, async (root) => {
    try {
      const html = await DashboardPage(async () => {
        const customers = await listCustomers(1);
        const stats = await getUserStats(customers);
        const plan = await getBilling(1);
        return { grid: await StatsGrid(customers, stats), plan };
      });
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    } catch (error) {
      res.writeHead(500).end(String(error));
    } finally {
      root.end();
    }
  });
});

server.listen(port, () => console.log(`shop on http://127.0.0.1:${port}/dashboard`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void flush().then(() => { server.close(); process.exit(0); }); });
}
