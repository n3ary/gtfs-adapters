import { describe, it, expect } from 'vitest';

import { TranzyClient, TranzyAuthError, TranzyRateLimitError, TranzyError } from '../src/sources/tranzy/index.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall {
  url: string;
  headers: any;
  signal: boolean;
}

function makeFetch(responses: Array<Response | Error>) {
  let i = 0;
  const calls: FetchCall[] = [];
  const fn = async (url: string | URL | Request, opts?: RequestInit): Promise<Response> => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: u, headers: opts?.headers, signal: !!opts?.signal });
    const next = responses[i++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next as Response;
  };
  return Object.assign(fn, { calls });
}

describe('TranzyClient auth headers', () => {
  it('sends X-API-KEY and X-AGENCY-ID on every call', async () => {
    const fetch = makeFetch([jsonResponse([])]);
    const client = new TranzyClient({
      apiKey: 'test-key',
      agencyId: 2,
      rateLimitMs: 0,
      maxRetries: 0,
      fetch,
    });
    await client.getRoutes();
    expect(fetch.calls).toHaveLength(1);
    const headers = fetch.calls[0]!.headers;
    expect(headers['X-API-KEY']).toBe('test-key');
    expect(headers['X-AGENCY-ID']).toBe('2');
    expect(headers['Accept']).toBe('application/json');
  });

  it('rejects when apiKey is missing', () => {
    expect(() => new TranzyClient({ apiKey: '', agencyId: 2, fetch: makeFetch([]) }))
      .toThrow(/apiKey is required/);
  });
});

describe('TranzyClient response handling', () => {
  it('returns parsed JSON on 200', async () => {
    const fetch = makeFetch([jsonResponse([{ route_id: 1 }])]);
    const client = new TranzyClient({ apiKey: 'k', agencyId: 2, rateLimitMs: 0, maxRetries: 0, fetch });
    const result = await client.getRoutes();
    expect(result).toEqual([{ route_id: 1 }]);
  });

  it('treats 404 as empty list', async () => {
    const fetch = makeFetch([new Response('not found', { status: 404 })]);
    const client = new TranzyClient({ apiKey: 'k', agencyId: 2, rateLimitMs: 0, maxRetries: 0, fetch });
    const result = await client.getCalendar();
    expect(result).toEqual([]);
  });

  it('throws TranzyAuthError on 401 without retrying', async () => {
    const fetch = makeFetch([new Response('unauthorized', { status: 401 })]);
    const client = new TranzyClient({ apiKey: 'k', agencyId: 2, rateLimitMs: 0, maxRetries: 3, fetch });
    await expect(client.getRoutes()).rejects.toBeInstanceOf(TranzyAuthError);
    expect(fetch.calls).toHaveLength(1); // no retry on 401
  });

  it('retries 5xx up to maxRetries then throws', async () => {
    const fetch = makeFetch([
      new Response('boom', { status: 500 }),
      new Response('boom', { status: 500 }),
      new Response('boom', { status: 500 }),
      new Response('boom', { status: 500 }),
    ]);
    const client = new TranzyClient({ apiKey: 'k', agencyId: 2, rateLimitMs: 0, maxRetries: 3, timeoutMs: 1000, fetch });
    await expect(client.getRoutes()).rejects.toBeInstanceOf(TranzyError);
    expect(fetch.calls).toHaveLength(4); // 1 + 3 retries
  });

  it('retries 429 then succeeds', async () => {
    const fetch = makeFetch([
      new Response('slow down', { status: 429 }),
      jsonResponse([{ route_id: 1 }]),
    ]);
    const client = new TranzyClient({ apiKey: 'k', agencyId: 2, rateLimitMs: 0, maxRetries: 3, timeoutMs: 1000, fetch });
    const result = await client.getRoutes();
    expect(result).toEqual([{ route_id: 1 }]);
    expect(fetch.calls).toHaveLength(2);
  });
});

describe('TranzyClient.fetchAll', () => {
  it('downgrades per-endpoint failures to empty arrays', async () => {
    const fetch = makeFetch([
      jsonResponse([{ route_id: 1 }]),
      jsonResponse([{ stop_id: 'a' }]),
      new Response('boom', { status: 500 }), // trips fails
      jsonResponse([]),
      jsonResponse([]),
      new Response('not found', { status: 404 }),
    ]);
    const client = new TranzyClient({ apiKey: 'k', agencyId: 2, rateLimitMs: 0, maxRetries: 0, fetch });
    const result = await client.fetchAll();
    expect(result.routes).toHaveLength(1);
    expect(result.stops).toHaveLength(1);
    expect(result.trips).toEqual([]);   // downgraded
    expect(result.shapes).toEqual([]);
    expect(result.stop_times).toEqual([]);
    expect(result.calendar).toEqual([]); // 404 also = []
  });
});
// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).