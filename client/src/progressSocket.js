// WebSocket connection to /api/ws for live job progress and oscilloscope
// connect/disconnect. Reconnects with backoff while the page is open. The
// WebSocket constructor is injectable for tests.

export function createProgressSocket({
  onEvent,
  WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : null,
  urlBase = typeof location !== 'undefined'
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
    : 'ws://localhost',
} = {}) {
  let ws = null;
  let closed = false;
  let retryMs = 1000;
  let timer = null;

  function connect() {
    if (closed || !WebSocketImpl) return;
    ws = new WebSocketImpl(`${urlBase}/api/ws`);
    ws.onopen = () => {
      retryMs = 1000;
    };
    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data);
        // 'hello' is the server greeting the socket; it carries no state.
        if (event.kind === 'job' || event.kind === 'device' || event.kind === 'queue') {
          onEvent(event);
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      timer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
  }

  connect();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ws) {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}
