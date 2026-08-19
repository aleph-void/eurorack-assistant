import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, insertModule } from './helpers.js';
import {
  YoutubeError,
  channelRefUrl,
  channelUrl,
  listChannelUploads,
  listChannelViaYtDlp,
  matchVideosToModules,
  parseChannelRef,
  resolveChannel,
} from '../src/services/youtube.js';

const CHANNEL_ID = 'UC' + 'a'.repeat(22);
const KEY = 'AIzaTestKey123';

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

const upload = (videoId, title, { description = '', publishedAt = '2026-01-01T00:00:00Z' } = {}) => ({
  snippet: { title, description, publishedAt, resourceId: { videoId } },
});

// A scripted stand-in for the YouTube Data API: channels.list answers with
// `channel` when the request carries one of the `respondsTo` lookup params,
// playlistItems.list serves `pages` chained by pageToken.
function youtubeFetch({
  channel = { id: CHANNEL_ID, snippet: { title: 'Synth Channel' }, contentDetails: { relatedPlaylists: { uploads: 'UUploads' } } },
  respondsTo = { forHandle: '@synthchan' },
  pages = [[]],
} = {}) {
  const calls = [];
  const fetchImpl = async (rawUrl) => {
    const url = new URL(rawUrl);
    calls.push(url);
    if (url.searchParams.get('key') !== KEY) return jsonResponse({ error: { message: 'bad key' } }, 400);
    if (url.pathname.endsWith('/channels')) {
      const hit = Object.entries(respondsTo).some(([param, value]) => url.searchParams.get(param) === value);
      return jsonResponse({ items: hit && channel ? [channel] : [] });
    }
    if (url.pathname.endsWith('/playlistItems')) {
      const page = Number(url.searchParams.get('pageToken')?.replace('page-', '') ?? 0);
      const body = { items: pages[page] ?? [] };
      if (page + 1 < pages.length) body.nextPageToken = `page-${page + 1}`;
      return jsonResponse(body);
    }
    return jsonResponse({ error: { message: 'unknown endpoint' } }, 404);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// A scripted stand-in for yt-dlp's flat channel listing: answers the
// --dump-single-json call with `entries`, or throws `fail`.
function ytDlpRun({ entries = [], channelId = CHANNEL_ID, fail = null } = {}) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (fail) throw new Error(fail);
    return JSON.stringify({ channel_id: channelId, channel: 'Synth Channel', entries });
  };
  run.calls = calls;
  return run;
}

describe('parseChannelRef', () => {
  it('reads every common channel link shape', () => {
    expect(parseChannelRef('@synthchan')).toEqual({ kind: 'handle', value: '@synthchan' });
    expect(parseChannelRef(CHANNEL_ID)).toEqual({ kind: 'id', value: CHANNEL_ID });
    expect(parseChannelRef('https://www.youtube.com/@synthchan')).toEqual({ kind: 'handle', value: '@synthchan' });
    expect(parseChannelRef('https://m.youtube.com/@synthchan/videos')).toEqual({ kind: 'handle', value: '@synthchan' });
    expect(parseChannelRef(`https://youtube.com/channel/${CHANNEL_ID}`)).toEqual({ kind: 'id', value: CHANNEL_ID });
    expect(parseChannelRef('https://www.youtube.com/user/synthguy')).toEqual({ kind: 'user', value: 'synthguy' });
    expect(parseChannelRef('https://www.youtube.com/c/SynthChannel')).toEqual({ kind: 'custom', value: 'SynthChannel' });
    // The oldest vanity form: the name is the whole path, tab suffix or not.
    expect(parseChannelRef('https://www.youtube.com/DivKidVideo')).toEqual({ kind: 'custom', value: 'DivKidVideo' });
    expect(parseChannelRef('https://www.youtube.com/DivKidVideo/videos')).toEqual({ kind: 'custom', value: 'DivKidVideo' });
  });

  it('rejects everything that is not a channel reference', () => {
    for (const input of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://vimeo.com/@synthchan',
      'https://example.com/channel/' + CHANNEL_ID,
      `ftp://youtube.com/channel/${CHANNEL_ID}`,
      'https://www.youtube.com/channel/not-a-channel-id',
      'https://www.youtube.com/',
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/feed/subscriptions',
      'https://www.youtube.com/results?search_query=maths',
      'https://www.youtube.com/DivKidVideo/not-a-tab',
      'not a url',
      '@x', // too short for a handle
      '',
      null,
    ]) {
      expect(parseChannelRef(input), String(input)).toBeNull();
    }
  });
});

describe('resolveChannel', () => {
  it('resolves a handle to id, title and uploads playlist', async () => {
    const fetchImpl = youtubeFetch();
    const channel = await resolveChannel(
      { kind: 'handle', value: '@synthchan' },
      { apiKey: KEY, fetchImpl }
    );
    expect(channel).toEqual({ id: CHANNEL_ID, title: 'Synth Channel', uploadsPlaylist: 'UUploads' });
    expect(channelUrl(channel.id)).toBe(`https://www.youtube.com/channel/${CHANNEL_ID}`);
  });

  it('falls back from forHandle to forUsername for legacy /c/ names', async () => {
    const fetchImpl = youtubeFetch({ respondsTo: { forUsername: 'SynthChannel' } });
    const channel = await resolveChannel(
      { kind: 'custom', value: 'SynthChannel' },
      { apiKey: KEY, fetchImpl }
    );
    expect(channel.id).toBe(CHANNEL_ID);
    // Both lookups were tried, in order.
    expect(fetchImpl.calls.map((u) => u.searchParams.has('forHandle'))).toEqual([true, false]);
  });

  it('throws a 404 YoutubeError when nothing answers', async () => {
    const fetchImpl = youtubeFetch({ channel: null });
    await expect(
      resolveChannel({ kind: 'handle', value: '@nobody' }, { apiKey: KEY, fetchImpl })
    ).rejects.toMatchObject({ name: 'YoutubeError', status: 404 });
  });

  it('turns a quota 403 into a 429 and other API failures into 502s', async () => {
    const quota = async () =>
      jsonResponse({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403);
    await expect(
      resolveChannel({ kind: 'handle', value: '@synthchan' }, { apiKey: KEY, fetchImpl: quota })
    ).rejects.toMatchObject({ status: 429 });

    const down = async () => jsonResponse({ error: { message: 'backend' } }, 500);
    await expect(
      resolveChannel({ kind: 'handle', value: '@synthchan' }, { apiKey: KEY, fetchImpl: down })
    ).rejects.toMatchObject({ status: 502 });

    const unreachable = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(
      resolveChannel({ kind: 'handle', value: '@synthchan' }, { apiKey: KEY, fetchImpl: unreachable })
    ).rejects.toBeInstanceOf(YoutubeError);
  });
});

describe('listChannelUploads', () => {
  const channel = { id: CHANNEL_ID, title: 'Synth Channel', uploadsPlaylist: 'UUploads' };

  it('pages through the uploads playlist and skips private/deleted entries', async () => {
    const fetchImpl = youtubeFetch({
      pages: [
        [upload('AAAAAAAAAA1', 'Maths tricks'), { snippet: { title: 'Private video', resourceId: { videoId: 'AAAAAAAAAA2' } } }],
        [upload('AAAAAAAAAA3', 'Plaits deep dive')],
      ],
    });
    const videos = await listChannelUploads(channel, { apiKey: KEY, fetchImpl });
    expect(videos.map((v) => v.video_id)).toEqual(['AAAAAAAAAA1', 'AAAAAAAAAA3']);
    expect(videos[0]).toMatchObject({ title: 'Maths tricks', published_at: '2026-01-01T00:00:00Z' });
  });

  it('stops at maxVideos without fetching further pages', async () => {
    const fetchImpl = youtubeFetch({
      pages: [
        [upload('AAAAAAAAAA1', 'one'), upload('AAAAAAAAAA2', 'two')],
        [upload('AAAAAAAAAA3', 'three')],
      ],
    });
    const videos = await listChannelUploads(channel, { apiKey: KEY, fetchImpl, maxVideos: 2 });
    expect(videos).toHaveLength(2);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('reads an empty or missing uploads playlist as no videos', async () => {
    expect(await listChannelUploads({ ...channel, uploadsPlaylist: null }, { apiKey: KEY })).toEqual([]);
    // A brand-new channel's uploads playlist 404s instead of paging empty.
    const gone = async () => jsonResponse({ error: { message: 'playlist not found' } }, 404);
    expect(await listChannelUploads(channel, { apiKey: KEY, fetchImpl: gone })).toEqual([]);
  });
});

describe('listChannelViaYtDlp (keyless fallback)', () => {
  const ref = { kind: 'handle', value: '@synthchan' };

  it('builds the videos-tab URL from the validated ref parts', () => {
    expect(channelRefUrl({ kind: 'handle', value: '@synthchan' })).toBe('https://www.youtube.com/@synthchan/videos');
    expect(channelRefUrl({ kind: 'id', value: CHANNEL_ID })).toBe(`https://www.youtube.com/channel/${CHANNEL_ID}/videos`);
    expect(channelRefUrl({ kind: 'user', value: 'synthguy' })).toBe('https://www.youtube.com/user/synthguy/videos');
    expect(channelRefUrl({ kind: 'custom', value: 'SynthChannel' })).toBe('https://www.youtube.com/c/SynthChannel/videos');
  });

  it('lists the flat playlist titles-only and skips unusable entries', async () => {
    const run = ytDlpRun({
      entries: [
        { id: 'AAAAAAAAAA1', title: 'Maths tutorial' },
        { id: 'not-an-id', title: 'junk row' },
        { id: 'AAAAAAAAAA2', title: 'Plaits deep dive' },
      ],
    });
    const { channel, videos } = await listChannelViaYtDlp(ref, { run });
    expect(channel).toEqual({ id: CHANNEL_ID, title: 'Synth Channel' });
    expect(videos).toEqual([
      { video_id: 'AAAAAAAAAA1', title: 'Maths tutorial', description: '', published_at: null },
      { video_id: 'AAAAAAAAAA2', title: 'Plaits deep dive', description: '', published_at: null },
    ]);
    const { cmd, args } = run.calls[0];
    expect(cmd).toBe('yt-dlp');
    expect(args).toContain('--flat-playlist');
    expect(args).toContain('https://www.youtube.com/@synthchan/videos');
  });

  it('caps the listing via --playlist-items and in the parsed result', async () => {
    const run = ytDlpRun({
      entries: [
        { id: 'AAAAAAAAAA1', title: 'one' },
        { id: 'AAAAAAAAAA2', title: 'two' },
        { id: 'AAAAAAAAAA3', title: 'three' },
      ],
    });
    const { videos } = await listChannelViaYtDlp(ref, { run, maxVideos: 2 });
    expect(videos).toHaveLength(2);
    expect(run.calls[0].args).toContain('1:2');
  });

  it('maps yt-dlp failures onto YoutubeErrors', async () => {
    await expect(
      listChannelViaYtDlp(ref, { run: ytDlpRun({ fail: 'ERROR: This channel does not exist.' }) })
    ).rejects.toMatchObject({ name: 'YoutubeError', status: 404 });
    await expect(
      listChannelViaYtDlp(ref, { run: ytDlpRun({ fail: 'network unreachable' }) })
    ).rejects.toMatchObject({ name: 'YoutubeError', status: 502 });
    await expect(listChannelViaYtDlp(ref, { run: async () => 'not json' })).rejects.toMatchObject({
      name: 'YoutubeError',
      status: 502,
    });
  });
});

describe('matchVideosToModules', () => {
  const maths = { id: 1, manufacturer: 'Make Noise', name: 'Maths' };
  const rings = { id: 2, manufacturer: 'Mutable Instruments', name: 'Rings' };
  const arp = { id: 3, manufacturer: '2hp', name: 'ARP' };

  it('matches whole words in title or description, never substrings', () => {
    const videos = [
      { video_id: 'AAAAAAAAAA1', title: 'Maths tutorial', description: '', published_at: '2026-01-02T00:00:00Z' },
      { video_id: 'AAAAAAAAAA2', title: 'Ambient jam', description: 'featuring Rings into Clouds', published_at: '2026-01-03T00:00:00Z' },
      { video_id: 'AAAAAAAAAA3', title: 'Guitar strings review', description: '', published_at: '2026-01-04T00:00:00Z' },
      { video_id: 'AAAAAAAAAA4', title: 'polymaths lecture', description: '', published_at: '2026-01-05T00:00:00Z' },
    ];
    const matches = matchVideosToModules(videos, [maths, rings]);
    expect(matches.get(maths.id).map((v) => v.video_id)).toEqual(['AAAAAAAAAA1']);
    expect(matches.get(rings.id)).toHaveLength(1);
    expect(matches.get(rings.id)[0]).toMatchObject({ video_id: 'AAAAAAAAAA2', matched_on: 'description' });
  });

  it('requires the manufacturer alongside a short module name', () => {
    const videos = [
      { video_id: 'AAAAAAAAAA1', title: 'ARP 2600 documentary', description: '', published_at: null },
      { video_id: 'AAAAAAAAAA2', title: 'ARP pluck patch', description: 'the 2hp ARP arpeggiator', published_at: null },
    ];
    const matches = matchVideosToModules(videos, [arp]);
    expect(matches.get(arp.id).map((v) => v.video_id)).toEqual(['AAAAAAAAAA2']);
  });

  it('puts title matches before description matches, newest first', () => {
    const videos = [
      { video_id: 'AAAAAAAAAA1', title: 'jam', description: 'with Maths', published_at: '2026-01-09T00:00:00Z' },
      { video_id: 'AAAAAAAAAA2', title: 'Maths basics', description: '', published_at: '2026-01-01T00:00:00Z' },
      { video_id: 'AAAAAAAAAA3', title: 'Maths advanced', description: '', published_at: '2026-01-05T00:00:00Z' },
    ];
    const matches = matchVideosToModules(videos, [maths]);
    expect(matches.get(maths.id).map((v) => v.video_id)).toEqual([
      'AAAAAAAAAA3',
      'AAAAAAAAAA2',
      'AAAAAAAAAA1',
    ]);
  });

  it('skips modules without a usable name and reports nothing for no matches', () => {
    const videos = [{ video_id: 'AAAAAAAAAA1', title: 'Maths tricks', description: '', published_at: null }];
    const matches = matchVideosToModules(videos, [{ id: 9, manufacturer: 'X', name: '  ' }, rings]);
    expect(matches.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Routes: POST /api/racks/:id/videos/channel-scan and .../videos/import
// ---------------------------------------------------------------------------

async function scanFixture({ fetchImpl, runImpl, withKey = true } = {}) {
  const context = await createTestApp({ fetchImpl, runImpl });
  const { app, db, adminCookie } = context;
  if (withKey) {
    const set = await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({ youtube_api_key: KEY });
    expect(set.status).toBe(200);
  }
  const { rows: users } = await db.query("SELECT id FROM users WHERE username = 'alice'");
  const alice = users[0];
  const maths = await insertModule(db, alice.id); // Make Noise Maths in 'main rack'
  const plaits = await insertModule(db, alice.id, { manufacturer: 'Mutable Instruments', name: 'Plaits' });
  return { ...context, alice, maths, plaits, rackId: maths.rack_id };
}

describe('POST /api/racks/:id/videos/channel-scan', () => {
  it('matches the channel’s uploads against the rack’s modules', async () => {
    const fetchImpl = youtubeFetch({
      pages: [
        [
          upload('AAAAAAAAAA1', 'Maths tutorial part 1'),
          upload('AAAAAAAAAA2', 'Generative jam', { description: 'Plaits into Rings' }),
          upload('AAAAAAAAAA3', 'Unrelated modular talk'),
        ],
      ],
    });
    const { app, db, aliceCookie, alice, maths, plaits, rackId } = await scanFixture({ fetchImpl });
    // One match is already analyzed and one failed earlier — the scan
    // reports both with their status instead of hiding them.
    await db.models.ModuleVideo.create({
      module_id: maths.id,
      user_id: alice.id,
      video_id: 'AAAAAAAAAA1',
      url: 'https://www.youtube.com/watch?v=AAAAAAAAAA1',
      status: 'complete',
    });
    await db.models.ModuleVideo.create({
      module_id: plaits.id,
      user_id: alice.id,
      video_id: 'AAAAAAAAAA2',
      url: 'https://www.youtube.com/watch?v=AAAAAAAAAA2',
      status: 'failed',
      error: 'yt-dlp exploded',
    });

    const res = await request(app)
      .post(`/api/racks/${rackId}/videos/channel-scan`)
      .set('Cookie', aliceCookie)
      .send({ url: 'https://www.youtube.com/@synthchan' });
    expect(res.status).toBe(200);
    expect(res.body.channel).toEqual({
      id: CHANNEL_ID,
      title: 'Synth Channel',
      url: `https://www.youtube.com/channel/${CHANNEL_ID}`,
    });
    expect(res.body.scanned).toBe(3);
    expect(res.body.modules).toHaveLength(2);
    const mathsGroup = res.body.modules.find((m) => m.module_id === maths.id);
    expect(mathsGroup.videos).toEqual([
      {
        video_id: 'AAAAAAAAAA1',
        url: 'https://www.youtube.com/watch?v=AAAAAAAAAA1',
        title: 'Maths tutorial part 1',
        published_at: '2026-01-01T00:00:00Z',
        matched_on: 'title',
        already_attached: true,
        attached_status: 'complete',
      },
    ]);
    // A failed earlier import is reported but stays importable — re-queueing
    // it is the retry.
    const plaitsGroup = res.body.modules.find((m) => m.module_id === plaits.id);
    expect(plaitsGroup.videos).toMatchObject([
      {
        video_id: 'AAAAAAAAAA2',
        matched_on: 'description',
        already_attached: false,
        attached_status: 'failed',
      },
    ]);
  });

  it('falls back to a yt-dlp listing when no API key is configured', async () => {
    const runImpl = ytDlpRun({
      entries: [
        { id: 'AAAAAAAAAA1', title: 'Maths tutorial part 1' },
        { id: 'AAAAAAAAAA2', title: 'Unrelated modular talk' },
      ],
    });
    const { app, aliceCookie, maths, rackId } = await scanFixture({ withKey: false, runImpl });
    const res = await request(app)
      .post(`/api/racks/${rackId}/videos/channel-scan`)
      .set('Cookie', aliceCookie)
      .send({ url: 'https://www.youtube.com/@synthchan' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('yt-dlp');
    expect(res.body.channel).toEqual({
      id: CHANNEL_ID,
      title: 'Synth Channel',
      url: `https://www.youtube.com/channel/${CHANNEL_ID}`,
    });
    expect(res.body.scanned).toBe(2);
    expect(res.body.modules).toHaveLength(1);
    expect(res.body.modules[0].module_id).toBe(maths.id);
    expect(res.body.modules[0].videos).toMatchObject([
      { video_id: 'AAAAAAAAAA1', matched_on: 'title', published_at: null },
    ]);
    // Only yt-dlp was consulted — no API traffic without a key.
    expect(runImpl.calls).toHaveLength(1);
  });

  it('rejects links that are not channels, with either backend', async () => {
    const { app, aliceCookie, rackId } = await scanFixture({ fetchImpl: youtubeFetch() });
    const bad = await request(app)
      .post(`/api/racks/${rackId}/videos/channel-scan`)
      .set('Cookie', aliceCookie)
      .send({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/channel link/);

    const keylessRun = ytDlpRun({});
    const keyless = await scanFixture({ withKey: false, runImpl: keylessRun });
    const alsoBad = await request(keyless.app)
      .post(`/api/racks/${keyless.rackId}/videos/channel-scan`)
      .set('Cookie', keyless.aliceCookie)
      .send({ url: 'https://vimeo.com/synthchan' });
    expect(alsoBad.status).toBe(400);
    expect(keylessRun.calls).toHaveLength(0);
  });

  it('answers with the YouTube error for unknown channels and is scoped to your own racks', async () => {
    const fetchImpl = youtubeFetch({ channel: null });
    const { app, aliceCookie, adminCookie, rackId } = await scanFixture({ fetchImpl });
    const notFound = await request(app)
      .post(`/api/racks/${rackId}/videos/channel-scan`)
      .set('Cookie', aliceCookie)
      .send({ url: '@nobody' });
    expect(notFound.status).toBe(404);
    expect(notFound.body.error).toMatch(/no YouTube channel/);

    // Someone else's rack is a 404 before any API call is made.
    const foreign = await request(app)
      .post(`/api/racks/${rackId}/videos/channel-scan`)
      .set('Cookie', adminCookie)
      .send({ url: '@synthchan' });
    expect(foreign.status).toBe(404);
  });
});

describe('POST /api/racks/:id/videos/import', () => {
  it('attaches the picked videos and queues one download job each', async () => {
    const { app, db, aliceCookie, alice, maths, plaits, rackId } = await scanFixture({});
    const res = await request(app)
      .post(`/api/racks/${rackId}/videos/import`)
      .set('Cookie', aliceCookie)
      .send({
        videos: [
          { module_id: maths.id, video_id: 'AAAAAAAAAA1', title: 'Maths tutorial part 1' },
          { module_id: plaits.id, video_id: 'AAAAAAAAAA2' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(2);
    expect(res.body.skipped).toBe(0);
    expect(res.body.videos.map((v) => [v.module_id, v.video_id, v.status])).toEqual([
      [maths.id, 'AAAAAAAAAA1', 'pending'],
      [plaits.id, 'AAAAAAAAAA2', 'pending'],
    ]);
    expect(res.body.videos[0].title).toBe('Maths tutorial part 1');
    expect(res.body.videos[0].url).toBe('https://www.youtube.com/watch?v=AAAAAAAAAA1');

    const jobs = await db.models.Job.findAll({ where: { type: 'download_video' } });
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.user_id)).toEqual([alice.id, alice.id]);
    expect(jobs.map((j) => JSON.parse(j.payload).video_id).sort()).toEqual(
      res.body.videos.map((v) => v.id).sort()
    );
  });

  it('skips already-attached videos and re-queues failed ones', async () => {
    const { app, db, aliceCookie, alice, maths, rackId } = await scanFixture({});
    await db.models.ModuleVideo.create({
      module_id: maths.id,
      user_id: alice.id,
      video_id: 'AAAAAAAAAA1',
      url: 'https://www.youtube.com/watch?v=AAAAAAAAAA1',
      status: 'complete',
    });
    const failed = await db.models.ModuleVideo.create({
      module_id: maths.id,
      user_id: alice.id,
      video_id: 'AAAAAAAAAA2',
      url: 'https://www.youtube.com/watch?v=AAAAAAAAAA2',
      status: 'failed',
      error: 'yt-dlp exploded',
    });

    const res = await request(app)
      .post(`/api/racks/${rackId}/videos/import`)
      .set('Cookie', aliceCookie)
      .send({
        videos: [
          { module_id: maths.id, video_id: 'AAAAAAAAAA1' },
          { module_id: maths.id, video_id: 'AAAAAAAAAA2' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(1);
    expect(res.body.skipped).toBe(1);
    await failed.reload();
    expect(failed.status).toBe('pending');
    expect(failed.error).toBeNull();
    // No duplicate rows were created.
    expect(await db.models.ModuleVideo.count()).toBe(2);
  });

  it('validates the selection list before importing anything', async () => {
    const { app, db, aliceCookie, adminCookie, maths, rackId } = await scanFixture({});

    const empty = await request(app)
      .post(`/api/racks/${rackId}/videos/import`)
      .set('Cookie', aliceCookie)
      .send({ videos: [] });
    expect(empty.status).toBe(400);

    // A module outside the rack rejects the whole request…
    const foreignModule = await request(app)
      .post(`/api/racks/${rackId}/videos/import`)
      .set('Cookie', aliceCookie)
      .send({
        videos: [
          { module_id: maths.id, video_id: 'AAAAAAAAAA1' },
          { module_id: 999, video_id: 'AAAAAAAAAA2' },
        ],
      });
    expect(foreignModule.status).toBe(400);
    expect(foreignModule.body.error).toMatch(/module in this rack/);

    // …as does a malformed video id — and nothing was attached or queued.
    const badId = await request(app)
      .post(`/api/racks/${rackId}/videos/import`)
      .set('Cookie', aliceCookie)
      .send({ videos: [{ module_id: maths.id, video_id: 'nope' }] });
    expect(badId.status).toBe(400);
    expect(await db.models.ModuleVideo.count()).toBe(0);
    expect(await db.models.Job.count({ where: { type: 'download_video' } })).toBe(0);

    // Another user cannot import into a rack that is not theirs.
    const foreignRack = await request(app)
      .post(`/api/racks/${rackId}/videos/import`)
      .set('Cookie', adminCookie)
      .send({ videos: [{ module_id: maths.id, video_id: 'AAAAAAAAAA1' }] });
    expect(foreignRack.status).toBe(404);
  });
});

describe('youtube_api_key config', () => {
  it('is saved through the config route and rejects keys with spaces', async () => {
    const { app, adminCookie } = await createTestApp();
    const saved = await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({ youtube_api_key: `  ${KEY}  ` });
    expect(saved.status).toBe(200);
    expect(saved.body.youtube_api_key).toBe(KEY);

    const bad = await request(app)
      .put('/api/config')
      .set('Cookie', adminCookie)
      .send({ youtube_api_key: 'two words' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/youtube_api_key/);
  });
});
