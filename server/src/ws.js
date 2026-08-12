// WebSocket endpoint (/api/ws) streaming per-user job progress events.
// Authentication reuses the session cookie from the HTTP upgrade request.

import { WebSocketServer } from 'ws';
import { getSessionUser, SESSION_COOKIE } from './auth.js';

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

export function attachWebSocketServer(httpServer, db, bus, { path = '/api/ws' } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const socketsByUser = new Map(); // userId -> Set<ws>

  httpServer.on('upgrade', async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    let user = null;
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      user = await getSessionUser(db, token);
    } catch {
      /* treated as unauthenticated */
    }
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, user);
    });
  });

  wss.on('connection', (ws, req, user) => {
    if (!socketsByUser.has(user.id)) socketsByUser.set(user.id, new Set());
    socketsByUser.get(user.id).add(ws);
    ws.send(JSON.stringify({ kind: 'hello', userId: user.id }));
    ws.on('close', () => {
      const set = socketsByUser.get(user.id);
      if (set) {
        set.delete(ws);
        if (set.size === 0) socketsByUser.delete(user.id);
      }
    });
    // Inbound messages are ignored; the socket is server-push only.
  });

  const unsubscribe = bus.subscribe((event) => {
    const set = socketsByUser.get(event.userId);
    if (!set) return;
    const data = JSON.stringify(event);
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  });

  return {
    wss,
    close() {
      unsubscribe();
      for (const set of socketsByUser.values()) for (const ws of set) ws.terminate();
      wss.close();
    },
  };
}
