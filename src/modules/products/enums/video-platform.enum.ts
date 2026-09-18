/**
 * Where a product's video lives. The storefront needs it to pick the right
 * player: a Facebook embed and a YouTube embed are built differently, and
 * guessing from the URL on every page view is work the admin can do once.
 */
export enum VideoPlatform {
  FACEBOOK = 'FACEBOOK',
  YOUTUBE = 'YOUTUBE',
}

/**
 * The hosts a video on each platform may be served from.
 *
 * Exact hostnames, not suffixes, so a lookalike such as
 * `facebook.com.evil.example` matches nothing. YouTube's cover the long form
 * (`/watch?v=`), Shorts (`/shorts/…`) and the `youtu.be` short link.
 */
export const VIDEO_HOSTS: Readonly<Record<VideoPlatform, readonly string[]>> = {
  [VideoPlatform.FACEBOOK]: [
    'facebook.com',
    'www.facebook.com',
    'm.facebook.com',
    'web.facebook.com',
    'fb.watch',
  ],
  [VideoPlatform.YOUTUBE]: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
};

/** Every host either platform allows — what the DTO checks a URL against. */
export const ALL_VIDEO_HOSTS: readonly string[] = Object.values(VIDEO_HOSTS).flat();

/** Is this URL served from the platform the admin said it is on? */
export function isVideoOnPlatform(url: string, platform: VideoPlatform): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return VIDEO_HOSTS[platform].includes(host);
}
