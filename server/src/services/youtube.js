// Scanning a YouTube channel for videos about the modules in a rack. Unlike
// the per-video pipeline (services/videos.js, which shells out to yt-dlp),
// listing a whole channel goes through the YouTube Data API v3 with the
// admin-configured key (app_config.youtube_api_key): one channels.list call
// to resolve whatever the user pasted into a channel id, then playlistItems
// pages over the channel's uploads playlist. Nothing the user typed reaches
// the API un-parsed — a pasted link is reduced to a handle / id / username
// first, and the API host is fixed.

export const API_BASE = 'https://www.googleapis.com/youtube/v3';

// How much of a channel one scan reads: 10 playlist pages of 50. Beyond that
// a channel's back catalogue is more cheaply searched one module at a time.
export const MAX_SCAN_VIDEOS = 500;

// How many matches one module reports; a channel with 30 videos about the
// same module is a channel the user should just browse.
export const MAX_MATCHES_PER_MODULE = 25;

// An API failure the route turns into a response rather than a 500. `status`
// is the HTTP status the route should answer with.
export class YoutubeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'YoutubeError';
    this.status = status;
  }
}

// Reduce whatever the user pasted to something channels.list can look up:
// a channel id (UC…), an @handle, or a legacy /user/ or /c/ name. Bare
// '@handle' and 'UC…' strings work as well as full URLs; trailing path
// segments (/videos, /featured) are ignored. Anything else is null.
const HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const LEGACY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function parseChannelRef(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (HANDLE.test(raw)) return { kind: 'handle', value: raw };
  if (CHANNEL_ID.test(raw)) return { kind: 'id', value: raw };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  if (host !== 'youtube.com' && host !== 'music.youtube.com') return null;
  const [first, second] = parsed.pathname.split('/').filter(Boolean);
  if (first?.startsWith('@')) return HANDLE.test(first) ? { kind: 'handle', value: first } : null;
  if (first === 'channel') return CHANNEL_ID.test(second ?? '') ? { kind: 'id', value: second } : null;
  if (first === 'user' || first === 'c') {
    return LEGACY_NAME.test(second ?? '') ? { kind: first === 'user' ? 'user' : 'custom', value: second } : null;
  }
  return null;
}

export const channelUrl = (channelId) => `https://www.youtube.com/channel/${channelId}`;

async function ytApi(endpoint, params, { apiKey, fetchImpl = fetch }) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('key', apiKey);
  let res;
  try {
    res = await fetchImpl(url.toString(), { headers: { accept: 'application/json' } });
  } catch (e) {
    throw new YoutubeError(`could not reach the YouTube API: ${e.message}`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* judged by status below */
  }
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason ?? '';
    if (res.status === 403 && /quota/i.test(reason)) {
      throw new YoutubeError('the YouTube API key is over its daily quota — try again later', 429);
    }
    if (res.status === 400 || res.status === 403) {
      throw new YoutubeError('the YouTube API rejected the configured API key — an admin can check it on the Config page');
    }
    const error = new YoutubeError(
      `the YouTube API answered ${res.status}: ${data?.error?.message || 'unknown error'}`
    );
    error.apiStatus = res.status;
    throw error;
  }
  return data ?? {};
}

// One channels.list call per lookup parameter until one hits. A legacy /c/
// custom URL has no lookup of its own: most became handles, some are the
// old username, so both are tried.
const LOOKUPS = {
  id: ['id'],
  handle: ['forHandle'],
  user: ['forUsername', 'forHandle'],
  custom: ['forHandle', 'forUsername'],
};

// Resolve a parsed channel ref to { id, title, uploadsPlaylist }.
export async function resolveChannel(ref, { apiKey, fetchImpl = fetch } = {}) {
  for (const param of LOOKUPS[ref.kind] ?? []) {
    const data = await ytApi(
      'channels',
      { part: 'snippet,contentDetails', [param]: ref.value, maxResults: '1' },
      { apiKey, fetchImpl }
    );
    const item = data.items?.[0];
    if (item) {
      return {
        id: item.id,
        title: item.snippet?.title ?? ref.value,
        uploadsPlaylist: item.contentDetails?.relatedPlaylists?.uploads ?? null,
      };
    }
  }
  throw new YoutubeError(`no YouTube channel found for '${ref.value}'`, 404);
}

// Every upload on the channel (newest first, capped at MAX_SCAN_VIDEOS):
// [{ video_id, title, description, published_at }].
export async function listChannelUploads(channel, { apiKey, fetchImpl = fetch, maxVideos = MAX_SCAN_VIDEOS } = {}) {
  if (!channel.uploadsPlaylist) return [];
  const videos = [];
  let pageToken = '';
  while (videos.length < maxVideos) {
    const params = {
      part: 'snippet',
      playlistId: channel.uploadsPlaylist,
      maxResults: '50',
    };
    if (pageToken) params.pageToken = pageToken;
    let data;
    try {
      data = await ytApi('playlistItems', params, { apiKey, fetchImpl });
    } catch (e) {
      // An empty uploads playlist 404s rather than answering with no items.
      if (e instanceof YoutubeError && e.apiStatus === 404 && videos.length === 0) return [];
      throw e;
    }
    for (const item of data.items ?? []) {
      const snippet = item.snippet ?? {};
      const videoId = snippet.resourceId?.videoId;
      // Private / deleted uploads keep a playlist entry but have nothing to
      // match on or import.
      if (!videoId || /^(Private|Deleted) video$/.test(snippet.title ?? '')) continue;
      videos.push({
        video_id: videoId,
        title: snippet.title ?? '',
        description: snippet.description ?? '',
        published_at: snippet.publishedAt ?? null,
      });
      if (videos.length >= maxVideos) break;
    }
    pageToken = data.nextPageToken ?? '';
    if (!pageToken) break;
  }
  return videos;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A video is 'about' a module when the module's name appears in its title or
// description as a whole word (so 'Rings' never matches 'strings'). Short
// names ('ARP', 'DFAM' is fine but 'ALT' is anyone's) collide with ordinary
// words too easily, so a name of 3 or fewer alphanumerics also needs the
// manufacturer somewhere in the text.
export function moduleMatcher(module) {
  const name = String(module.name ?? '').trim();
  if (!name) return null;
  const pattern = escapeRegExp(name).replace(/\s+/g, '\\s+');
  const nameRe = new RegExp(`(^|[^a-z0-9])${pattern}($|[^a-z0-9])`, 'i');
  const manufacturer = String(module.manufacturer ?? '').trim().toLowerCase();
  const needManufacturer = name.replace(/[^a-z0-9]/gi, '').length <= 3 && manufacturer !== '';
  return { nameRe, manufacturer, needManufacturer };
}

// Match a channel's videos against a rack's modules. Returns a Map of
// module id -> [{ ...video, matched_on: 'title' | 'description' }], title
// matches first, newest first within each group.
export function matchVideosToModules(videos, modules) {
  const matches = new Map();
  for (const module of modules) {
    const matcher = moduleMatcher(module);
    if (!matcher) continue;
    const found = [];
    for (const video of videos) {
      const inTitle = matcher.nameRe.test(video.title);
      const matched = inTitle || matcher.nameRe.test(video.description);
      if (!matched) continue;
      if (matcher.needManufacturer) {
        const text = `${video.title}\n${video.description}`.toLowerCase();
        if (!text.includes(matcher.manufacturer)) continue;
      }
      found.push({ ...video, matched_on: inTitle ? 'title' : 'description' });
    }
    found.sort((a, b) => {
      if (a.matched_on !== b.matched_on) return a.matched_on === 'title' ? -1 : 1;
      return String(b.published_at ?? '').localeCompare(String(a.published_at ?? ''));
    });
    if (found.length) matches.set(module.id, found.slice(0, MAX_MATCHES_PER_MODULE));
  }
  return matches;
}
