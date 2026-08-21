// Thin JSON fetch wrapper. Throws ApiError with the server's error message,
// and raises a red toast on the way out: every page reports its own failures
// inline, but only where that page happens to draw them, so a refusal while
// the user is looking somewhere else would otherwise pass unseen.

import { toast } from './toast.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// `quiet` is for the calls whose failure is not news: a secondary fetch the
// caller already shrugs off (autocomplete lists, suggestions), or a request
// whose refusal IS the answer.
async function call(method, path, body, { quiet = false } = {}) {
  const options = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, options);
  } catch (e) {
    // No response at all: the server is down, or the connection is.
    if (!quiet) toast.error('Could not reach the server — the request was not sent.');
    throw e;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const message = data?.error || `Request failed (${res.status})`;
    // 401 is not a failure worth announcing: the app asks who the viewer is
    // on every load, and "nobody" is a normal answer that the router already
    // acts on by showing the login page.
    if (!quiet && res.status !== 401) toast.error(message);
    throw new ApiError(res.status, message);
  }
  return data;
}

export const api = {
  get: (path, options) => call('GET', path, undefined, options),
  post: (path, body, options) => call('POST', path, body, options),
  put: (path, body, options) => call('PUT', path, body, options),
  patch: (path, body, options) => call('PATCH', path, body, options),
  delete: (path, options) => call('DELETE', path, undefined, options),
};
