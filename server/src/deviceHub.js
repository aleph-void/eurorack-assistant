// Registry of connected oscilloscope applications, and the request/response
// layer over their sockets.
//
// The job-progress socket in ws.js is server-push only: events go out, nothing
// comes back. A scope is the other shape — the browser asks it for a waveform
// and waits for the answer — so connections here are addressable, carry the
// state the device announced, and match replies to requests by id.
//
// The hub knows nothing about WebSockets: a connection is registered with a
// `send` function and fed inbound messages. That keeps it drivable from tests
// without sockets, and keeps ws.js as the only place framing lives.

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

let nextConnectionId = 1;
let nextRequestId = 1;

// What a device tells us about itself. Everything is optional — a device that
// announces nothing is still usable, it just cannot be auto-mapped.
function normalizeState(message = {}) {
  const audio = message.audio_device || {};
  const channels = Array.isArray(message.channels) ? message.channels : [];
  return {
    app: message.app ? String(message.app).slice(0, 120) : null,
    version: message.version ? String(message.version).slice(0, 60) : null,
    audio_device: {
      id: audio.id ? String(audio.id).slice(0, 200) : null,
      name: audio.name ? String(audio.name).slice(0, 200) : null,
      channel_count: Number.isFinite(Number(audio.channel_count))
        ? Number(audio.channel_count)
        : channels.length,
      sample_rate: Number.isFinite(Number(audio.sample_rate)) ? Number(audio.sample_rate) : null,
    },
    channels: channels.map((c, i) => ({
      index: Number.isInteger(c?.index) ? c.index : i,
      name: c?.name ? String(c.name).slice(0, 120) : `CH ${i + 1}`,
      signal_type: c?.signal_type === 'cv' ? 'cv' : 'audio',
      selected: Boolean(c?.selected),
      vertical_range: Number.isFinite(Number(c?.vertical_range)) ? Number(c.vertical_range) : null,
      vertical_offset: Number.isFinite(Number(c?.vertical_offset)) ? Number(c.vertical_offset) : null,
      time_base: Number.isFinite(Number(c?.time_base)) ? Number(c.time_base) : null,
    })),
    // Which of the device's own features are available (tuner behind an
    // entitlement, recording, ...). Absent means "assume yes".
    capabilities: Array.isArray(message.capabilities)
      ? message.capabilities.map((c) => String(c).slice(0, 40))
      : null,
  };
}

export function createDeviceHub({
  bus = null,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const byUser = new Map(); // userId -> Map(connectionId -> connection)

  const publish = (userId, event, connection, extra = {}) => {
    if (!bus) return;
    bus.publish(userId, {
      kind: 'device',
      event,
      device: connection ? summarize(connection) : null,
      ...extra,
    });
  };

  const summarize = (conn) => ({
    id: conn.id,
    token_id: conn.tokenId,
    name: conn.name,
    client_id: conn.clientId,
    connected_at: conn.connectedAt,
    ...conn.state,
  });

  function register({ userId, tokenId, name, clientId, send, close = () => {} }) {
    const connection = {
      id: nextConnectionId++,
      userId,
      tokenId,
      name: name || 'Oscilloscope',
      clientId: clientId || null,
      connectedAt: new Date(now()).toISOString(),
      state: normalizeState({}),
      pending: new Map(),
      send,
      close,
    };
    if (!byUser.has(userId)) byUser.set(userId, new Map());
    byUser.get(userId).set(connection.id, connection);
    publish(userId, 'connected', connection);
    return connection;
  }

  // A socket that errors and then closes calls this twice; the second call
  // must not announce a second disconnect.
  function unregister(connection, reason = 'closed') {
    if (connection.gone) return;
    connection.gone = true;
    const set = byUser.get(connection.userId);
    if (set) {
      set.delete(connection.id);
      if (set.size === 0) byUser.delete(connection.userId);
    }
    // Anything still waiting on this device will never be answered.
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`device disconnected (${reason})`));
    }
    connection.pending.clear();
    publish(connection.userId, 'disconnected', connection);
  }

  // Inbound frame from a device. Returns true when it was consumed.
  function handleMessage(connection, message) {
    if (!message || typeof message !== 'object') return false;
    switch (message.type) {
      case 'hello':
      case 'state': {
        connection.state = normalizeState(message);
        if (message.device_name) connection.name = String(message.device_name).slice(0, 120);
        publish(connection.userId, message.type === 'hello' ? 'connected' : 'state', connection);
        return true;
      }
      case 'result':
      case 'error': {
        const pending = connection.pending.get(message.request_id);
        if (!pending) return false; // late answer to a request that already timed out
        connection.pending.delete(message.request_id);
        clearTimeout(pending.timer);
        if (message.type === 'error') {
          pending.reject(new Error(String(message.error || 'device reported an error')));
        } else {
          pending.resolve(message.payload ?? {});
        }
        return true;
      }
      default:
        return false;
    }
  }

  // Ask a device to do something and wait for its answer. Rejects on timeout
  // or disconnect — the caller turns that into an HTTP status.
  function request(connection, action, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const requestId = `r${nextRequestId++}`;
      const timer = setTimeout(() => {
        connection.pending.delete(requestId);
        reject(new Error(`device did not answer ${action} within ${timeoutMs}ms`));
      }, timeoutMs);
      // Node would otherwise hold the process open for the timeout.
      if (typeof timer.unref === 'function') timer.unref();
      connection.pending.set(requestId, { resolve, reject, timer });
      try {
        connection.send({ type: 'request', request_id: requestId, action, params });
      } catch (e) {
        connection.pending.delete(requestId);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  return {
    register,
    unregister,
    handleMessage,
    request,
    summarize,
    list(userId) {
      return [...(byUser.get(userId)?.values() ?? [])].map(summarize);
    },
    connections(userId) {
      return [...(byUser.get(userId)?.values() ?? [])];
    },
    get(userId, connectionId) {
      return byUser.get(userId)?.get(Number(connectionId)) ?? null;
    },
    // The device a request should go to when the caller did not name one:
    // the only connection, or the most recently connected.
    pick(userId, connectionId = null) {
      if (connectionId) return this.get(userId, connectionId);
      const list = this.connections(userId);
      return list.length === 0 ? null : list[list.length - 1];
    },
    // Every live connection using a given token (revocation cuts them off).
    closeToken(tokenId) {
      for (const set of byUser.values()) {
        for (const conn of set.values()) {
          if (conn.tokenId === tokenId) conn.close(4003, 'token revoked');
        }
      }
    },
    closeAll() {
      for (const set of byUser.values()) {
        for (const conn of set.values()) conn.close(1001, 'server shutting down');
      }
      byUser.clear();
    },
  };
}
