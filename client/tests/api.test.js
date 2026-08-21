import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError } from '../src/api.js';
import { clearToasts, toastState } from '../src/toast.js';

function mockFetch(status, body) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

afterEach(clearToasts);

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

  // Every page reports its own failures inline, but only where that page
  // draws them — a refusal while the user is looking elsewhere on a long page
  // would otherwise pass unseen.
  it('raises a red toast carrying the server\u2019s message', async () => {
    vi.stubGlobal('fetch', mockFetch(400, { error: 'row 1 exceeds its 84HP capacity' }));
    await expect(api.put('/api/racks/1/layout', {})).rejects.toThrow('row 1 exceeds');
    expect(toastState.items).toHaveLength(1);
    expect(toastState.items[0].kind).toBe('error');
    expect(toastState.items[0].message).toBe('row 1 exceeds its 84HP capacity');
  });

  // The app asks who the viewer is on every load; 'nobody' is an ordinary
  // answer the router already acts on.
  it('says nothing about a 401, or about a call that opted out', async () => {
    vi.stubGlobal('fetch', mockFetch(401, { error: 'Not authenticated' }));
    await expect(api.get('/api/auth/me')).rejects.toThrow();
    expect(toastState.items).toHaveLength(0);

    vi.stubGlobal('fetch', mockFetch(500, { error: 'boom' }));
    await expect(api.get('/api/modules', { quiet: true })).rejects.toThrow();
    expect(toastState.items).toHaveLength(0);
  });

  it('reports a request that never reached the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(api.get('/api/racks')).rejects.toThrow('Failed to fetch');
    expect(toastState.items[0].message).toContain('Could not reach the server');
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
