/**
 * Decode an OTLP/HTTP JSON trace payload.
 *
 * Times arrive as decimal strings because they are int64 nanoseconds since the
 * epoch (~1.8e18), well past what a double can hold exactly. We keep them as
 * bigint all the way into storage and only convert to Number once a trace is
 * read back and rebased against its own start.
 */

export interface StoredSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startNs: bigint;
  endNs: bigint;
  attributes: Record<string, string | number | boolean>;
}

type AnyValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyValue[] };
};

function decodeValue(value: AnyValue | undefined): string | number | boolean | undefined {
  if (value === undefined) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue?.values) {
    return value.arrayValue.values.map((v) => String(decodeValue(v) ?? '')).join(',');
  }
  return undefined;
}

function decodeAttributes(
  list: Array<{ key?: string; value?: AnyValue }> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const entry of list ?? []) {
    if (entry.key === undefined) continue;
    const value = decodeValue(entry.value);
    if (value !== undefined) out[entry.key] = value;
  }
  return out;
}

const asBigInt = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.round(v));
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return 0n;
};

/** Resource attributes are merged in, so `service.name` reaches the graph. */
export function decodeOtlp(payload: unknown): StoredSpan[] {
  const root = payload as {
    resourceSpans?: Array<{
      resource?: { attributes?: Array<{ key?: string; value?: AnyValue }> };
      scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }>;
    }>;
  };
  const out: StoredSpan[] = [];

  for (const resourceSpan of root.resourceSpans ?? []) {
    const resourceAttrs = decodeAttributes(resourceSpan.resource?.attributes);
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        const traceId = String(span['traceId'] ?? '');
        const spanId = String(span['spanId'] ?? '');
        if (traceId === '' || spanId === '') continue;
        const parent = span['parentSpanId'];
        const parentSpanId = typeof parent === 'string' && parent !== '' ? parent : null;
        out.push({
          traceId,
          spanId,
          parentSpanId,
          name: String(span['name'] ?? ''),
          startNs: asBigInt(span['startTimeUnixNano']),
          endNs: asBigInt(span['endTimeUnixNano']),
          attributes: {
            ...resourceAttrs,
            ...decodeAttributes(span['attributes'] as Array<{ key?: string; value?: AnyValue }>),
          },
        });
      }
    }
  }
  return out;
}
