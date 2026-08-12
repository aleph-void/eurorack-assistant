import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, ApiError } from '../src/api.js';

function mockFetch(status, body) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('api wrapper', () => {
  it('GETs JSON', async () => {
    const fetchMock = mockFetch(200, { hello: 'world' });
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.get('/api/health')).toEqual({ hello: 'world' });
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ method: 'GET' }));
  });

  it('POSTs a JSON body with content-type', async () => {
    const fetchMock = mockFetch(201, { id: 1 });
    vi.stubGlobal('fetch', fetchMock);
    await api.post('/api/questions', { prompt: 'hi' });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ prompt: 'hi' });
  });

  it('throws ApiError with the server message', async () => {
    vi.stubGlobal('fetch', mockFetch(401, { error: 'Not authenticated' }));
    await expect(api.get('/api/auth/me')).rejects.toThrow('Not authenticated');
    await expect(api.get('/api/auth/me')).rejects.toBeInstanceOf(ApiError);
  });

  it('falls back to a generic message for non-JSON errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    })));
    await expect(api.get('/x')).rejects.toThrow('Request failed (502)');
  });
});
