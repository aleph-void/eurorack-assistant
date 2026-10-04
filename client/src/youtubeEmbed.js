// Where a performance's player comes from.
//
// One function, so there is one place that knows the host: it is the host the
// client shell's content security policy names in frame-src (nginx/csp.conf),
// and the two have to agree or every performance page is an empty box. The
// privacy-enhanced host is used so the player sets no tracking cookie until
// the viewer presses play. The id is held to the eleven characters YouTube
// uses, exactly as the server held it on the way in (services/videos.js):
// nothing user-typed is ever written into the frame's address.

export const EMBED_HOST = 'https://www.youtube-nocookie.com';

export function youtubeEmbedUrl(videoId) {
  const id = String(videoId ?? '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  return `${EMBED_HOST}/embed/${id}`;
}
