import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { trace, SpanStatusCode, context } from '@opentelemetry/api';

/** Real OpenTelemetry, exporting OTLP/HTTP to the Vibez receiver. */
const provider = new NodeTracerProvider({
  resource: new Resource({ 'service.name': 'shop' }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: process.env['VIBEZ_OTLP'] ?? 'http://127.0.0.1:4318/v1/traces' }),
      { scheduledDelayMillis: 200, maxExportBatchSize: 256 },
    ),
  ],
});
provider.register();

export const tracer = trace.getTracer('shop');
export const flush = (): Promise<void> => provider.forceFlush();

export async function span<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (s) => {
    try {
      return await fn();
    } catch (error) {
      s.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      throw error;
    } finally {
      s.end();
    }
  });
}

export { context };
