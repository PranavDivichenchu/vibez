/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { RawSpan } from '../common/vibezSpans.js';

type AnyValue = {
	stringValue?: string;
	intValue?: string | number;
	doubleValue?: number;
	boolValue?: boolean;
};

function decodeValue(value: AnyValue | undefined): string | number | boolean | undefined {
	if (!value) { return undefined; }
	if (value.stringValue !== undefined) { return value.stringValue; }
	if (value.intValue !== undefined) { return Number(value.intValue); }
	if (value.doubleValue !== undefined) { return value.doubleValue; }
	if (value.boolValue !== undefined) { return value.boolValue; }
	return undefined;
}

function decodeAttributes(list: { key?: string; value?: AnyValue }[] | undefined): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	for (const entry of list ?? []) {
		if (!entry.key) { continue; }
		const value = decodeValue(entry.value);
		if (value !== undefined) { out[entry.key] = value; }
	}
	return out;
}

const asBigInt = (value: unknown): bigint => {
	if (typeof value === 'bigint') { return value; }
	if (typeof value === 'number') { return BigInt(Math.round(value)); }
	if (typeof value === 'string' && /^\d+$/.test(value)) { return BigInt(value); }
	return 0n;
};

export interface DecodedSpan extends Omit<RawSpan, 'startNs' | 'endNs'> {
	startNs: bigint;
	endNs: bigint;
}

/**
 * Decodes an OTLP/HTTP JSON payload.
 *
 * Timestamps stay bigint. They are int64 nanoseconds since the epoch, around
 * 1.75e18, which is past the point where a double is exact — decoding them
 * through Number loses precision silently.
 */
export function decodeOtlp(payload: unknown): DecodedSpan[] {
	const root = payload as {
		resourceSpans?: {
			resource?: { attributes?: { key?: string; value?: AnyValue }[] };
			scopeSpans?: { spans?: Record<string, unknown>[] }[];
		}[];
	};
	const out: DecodedSpan[] = [];

	for (const resourceSpan of root.resourceSpans ?? []) {
		const resourceAttributes = decodeAttributes(resourceSpan.resource?.attributes);
		for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
			for (const span of scopeSpan.spans ?? []) {
				const traceId = String(span['traceId'] ?? '');
				const spanId = String(span['spanId'] ?? '');
				if (!traceId || !spanId) { continue; }
				const parent = span['parentSpanId'];
				out.push({
					traceId,
					spanId,
					...(typeof parent === 'string' && parent ? { parentSpanId: parent } : {}),
					name: String(span['name'] ?? ''),
					startNs: asBigInt(span['startTimeUnixNano']),
					endNs: asBigInt(span['endTimeUnixNano']),
					attributes: {
						...resourceAttributes,
						...decodeAttributes(span['attributes'] as { key?: string; value?: AnyValue }[])
					}
				});
			}
		}
	}
	return out;
}

/** Rebase each trace against its own earliest span so all later maths is exact. */
export function toRawSpans(spans: DecodedSpan[]): RawSpan[] {
	const base = new Map<string, bigint>();
	for (const span of spans) {
		const current = base.get(span.traceId);
		if (current === undefined || span.startNs < current) {
			base.set(span.traceId, span.startNs);
		}
	}
	return spans.map(span => {
		const zero = base.get(span.traceId) ?? 0n;
		return {
			...span,
			startNs: Number(span.startNs - zero),
			endNs: Number(span.endNs - zero)
		};
	});
}
