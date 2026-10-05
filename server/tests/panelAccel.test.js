// Panel pictures sent by nginx: with an accel prefix the route answers with
// an X-Accel-Redirect naming the file under it and no body, and the headers
// nginx carries across a redirect (Content-Type, Cache-Control) are still
// the route's. Without one, the bytes are streamed as before.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createTestApp, insertModule, PNG_BYTES } from './helpers.js';
import { panelPath } from '../src/services/image.js';
import { STORED_FILE_POLICY } from '../src/csp.js';

async function storedPanel(ctx) {
  const alice = await ctx.db.models.User.findOne({ where: { username: 'alice' } });
  const module = await insertModule(ctx.db, alice.id);
  const hash = crypto.createHash('sha256').update(PNG_BYTES).digest('hex');
  fs.writeFileSync(panelPath(ctx.panelsDir, hash, 'png'), PNG_BYTES);
  await ctx.db.models.ModulePanel.create({
    module_id: module.id,
    source: 'image',
    image_hash: hash,
    image_ext: 'png',
    width: 400,
    height: 1200,
  });
  return hash;
}

describe('panel pictures sent by nginx', () => {
  it('redirects to the file under the prefix, with the headers nginx keeps', async () => {
    const ctx = await createTestApp({ panelsAccelPrefix: '/_panels' });
    const hash = await storedPanel(ctx);
    const res = await request(ctx.app)
      .get(`/api/panels/${hash}.png`)
      .set('Cookie', ctx.aliceCookie);
    expect(res.status).toBe(200);
    expect(res.headers['x-accel-redirect']).toBe(`/_panels/${hash}.png`);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(res.headers['content-security-policy']).toBe(STORED_FILE_POLICY);
    // No body: nginx sends the file's own bytes and sizes them itself.
    expect(res.headers['content-length']).toBe('0');
    expect(res.body.length ?? Object.keys(res.body).length).toBe(0);
  });

  it('names a width variant under thumbs/ when one can be rendered', async () => {
    const ctx = await createTestApp({ panelsAccelPrefix: '/_panels' });
    const hash = await storedPanel(ctx);
    const res = await request(ctx.app)
      .get(`/api/panels/${hash}.png?w=128`)
      .set('Cookie', ctx.aliceCookie);
    expect(res.status).toBe(200);
    const redirect = res.headers['x-accel-redirect'];
    // An install without sharp serves the original; one with it serves the
    // rendered variant. Either way the path is under the prefix, and it is
    // the file the route would otherwise have streamed.
    if (fs.existsSync(path.join(ctx.panelsDir, 'thumbs', `${hash}@128.webp`))) {
      expect(redirect).toBe(`/_panels/thumbs/${hash}@128.webp`);
      expect(res.headers['content-type']).toBe('image/webp');
    } else {
      expect(redirect).toBe(`/_panels/${hash}.png`);
    }
  });

  it('still refuses a name no panel references, before any redirect', async () => {
    const ctx = await createTestApp({ panelsAccelPrefix: '/_panels' });
    const hash = crypto.createHash('sha256').update('nobody').digest('hex');
    fs.writeFileSync(panelPath(ctx.panelsDir, hash, 'png'), PNG_BYTES);
    const res = await request(ctx.app)
      .get(`/api/panels/${hash}.png`)
      .set('Cookie', ctx.aliceCookie);
    expect(res.status).toBe(404);
    expect(res.headers['x-accel-redirect']).toBeUndefined();
  });

  it('streams the bytes itself when no prefix is set', async () => {
    const ctx = await createTestApp();
    const hash = await storedPanel(ctx);
    const res = await request(ctx.app)
      .get(`/api/panels/${hash}.png`)
      .set('Cookie', ctx.aliceCookie)
      .buffer()
      .parse((stream, done) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['x-accel-redirect']).toBeUndefined();
    expect(res.headers['content-length']).toBe(String(PNG_BYTES.length));
    expect(Buffer.compare(res.body, PNG_BYTES)).toBe(0);
  });
});
