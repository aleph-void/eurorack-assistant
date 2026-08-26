import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProgressSocket } from '../src/progressSocket.js';

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.useRealTimers();
});

describe('progress socket', () => {
  it('connects to /api/ws and forwards job events', () => {
    const events = [];
    createProgressSocket({
      onEvent: (e) => events.push(e),
      WebSocketImpl: FakeWebSocket,
      urlBase: 'ws://test',
    });
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('ws://test/api/ws');

    ws.onmessage({ data: JSON.stringify({ kind: 'job', event: 'progress', job: { id: 1 } }) });
    ws.onmessage({ data: JSON.stringify({ kind: 'hello' }) });
    ws.onmessage({ data: 'not json' });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('progress');
  });

  // Presence is announced by CHANGES only, so whoever cares reads the state
  // again on every socket that comes up — the first one included.
  it('says when a socket has come up, on the first connection and on a retry', () => {
    vi.useFakeTimers();
    const opens = [];
    createProgressSocket({
      onEvent: () => {},
      onOpen: () => opens.push(FakeWebSocket.instances.length),
      WebSocketImpl: FakeWebSocket,
      urlBase: 'ws://t',
    });
    FakeWebSocket.instances[0].onopen();
    FakeWebSocket.instances[0].onclose();
    vi.advanceTimersByTime(1100);
    FakeWebSocket.instances[1].onopen();
    expect(opens).toEqual([1, 2]);
  });

  it('reconnects with backoff after close', () => {
    vi.useFakeTimers();
    createProgressSocket({ onEvent: () => {}, WebSocketImpl: FakeWebSocket, urlBase: 'ws://t' });
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].onclose();
    vi.advanceTimersByTime(1100);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('stops reconnecting after close()', () => {
    vi.useFakeTimers();
    const socket = createProgressSocket({
      onEvent: () => {},
      WebSocketImpl: FakeWebSocket,
      urlBase: 'ws://t',
    });
    socket.close();
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
