// WebSocket endpoints.
//
//   /api/ws         — per-user job progress, authenticated by the session
//                     cookie from the HTTP upgrade. Server-push only.
//   /api/devices/ws — oscilloscope applications, authenticated by the bearer
//                     device token from the OAuth device grant. Bidirectional:
//                     the browser asks a device for a capture through the hub.
//
// Both live behind one 'upgrade' listener on purpose. Two listeners would each
// destroy the sockets meant for the other, since neither can tell "not my
// path" from "nobody's path".

import { WebSocketServer } from 'ws';
import { ALL_USERS } from './events.js';
import { getSessionUser, SESSION_COOKIE } from './auth.js';
import { getDeviceTokenUser, hasScope, touchDeviceToken } from './services/deviceAuth.js';

// A rendered waveform arrives as base64 inside the result frame, so the limit
// has to fit an image rather than a control message.
export const DEVICE_MAX_PAYLOAD_BYTES = 12 * 1024 * 1024;
export const DEVICE_SCOPE = 'oscilloscope';

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

// A native app can set an Authorization header; a browser-based client can't,
// so a token in the query string is accepted as well. Sec-WebSocket-Protocol
// is the third form some clients prefer.
function bearerToken(req, url) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match) return match[1].trim();
  const query = url.searchParams.get('access_token');
  if (query) return query;
  const protocols = String(req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((p) => p.trim());
  const bearerIndex = protocols.indexOf('bearer');
  if (bearerIndex !== -1 && protocols[bearerIndex + 1]) return protocols[bearerIndex + 1];
  return null;
}

function reject(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function attachWebSocketServer(
  httpServer,
  db,
  bus,
  { path = '/api/ws', devicePath = '/api/devices/ws', hub = null } = {}
) {
  const wss = new WebSocketServer({ noServer: true });
  const deviceWss = hub
    ? new WebSocketServer({ noServer: true, maxPayload: DEVICE_MAX_PAYLOAD_BYTES })
    : null;
  const socketsByUser = new Map(); // userId -> Set<ws>

  httpServer.on('upgrade', async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname === devicePath && deviceWss) {
      let found = null;
      try {
        found = await getDeviceTokenUser(db, bearerToken(req, url));
      } catch {
        /* treated as unauthenticated */
      }
      if (!found) return reject(socket, 401, 'Unauthorized');
      if (!hasScope(found.token.scopes, DEVICE_SCOPE)) return reject(socket, 403, 'Forbidden');
      deviceWss.handleUpgrade(req, socket, head, (ws) => {
        deviceWss.emit('connection', ws, req, found);
      });
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
    if (!user) return reject(socket, 401, 'Unauthorized');
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

  if (deviceWss) {
    deviceWss.on('connection', (ws, req, { user, token }) => {
      const connection = hub.register({
        userId: user.id,
        tokenId: token.id,
        name: token.name,
        clientId: token.client_id,
        send: (message) => ws.send(JSON.stringify(message)),
        close: (code, reason) => ws.close(code, reason),
      });
      touchDeviceToken(db, token.id).catch(() => {
        /* last_seen is best effort */
      });
      ws.send(
        JSON.stringify({
          type: 'welcome',
          protocol: 1,
          connection_id: connection.id,
          user: { id: user.id, username: user.username },
          server_time: new Date().toISOString(),
        })
      );
      ws.on('message', (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return; // malformed frames are ignored, not fatal
        }
        hub.handleMessage(connection, message);
      });
      ws.on('close', () => hub.unregister(connection));
      ws.on('error', () => hub.unregister(connection, 'socket error'));
    });
  }

  const unsubscribe = bus.subscribe((event) => {
    // Queue-wide events (the job queue stopping and starting) are addressed
    // to everyone; everything else goes to the one user it is about.
    const sets =
      event.userId === ALL_USERS ? [...socketsByUser.values()] : [socketsByUser.get(event.userId)];
    const data = JSON.stringify(event);
    for (const set of sets) {
      if (!set) continue;
      for (const ws of set) {
        if (ws.readyState === ws.OPEN) ws.send(data);
      }
    }
  });

  return {
    wss,
    deviceWss,
    close() {
      unsubscribe();
      for (const set of socketsByUser.values()) for (const ws of set) ws.terminate();
      wss.close();
      if (deviceWss) {
        for (const ws of deviceWss.clients) ws.terminate();
        deviceWss.close();
      }
    },
  };
}
