import { CookieOptions, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { parseDuration } from './duration';

export const GUEST_COOKIE = 'guest_token';
const GUEST_COOKIE_TTL_MS = parseDuration('30d');

/**
 * A shopper with no account is identified by a signed cookie.
 *
 * Signed, so a client cannot claim another guest's order by guessing or editing
 * the value — Express verifies the HMAC and discards a tampered cookie.
 * `httpOnly` keeps it out of reach of page scripts, and `sameSite=lax` means it
 * still rides along on a normal navigation back from a payment provider.
 *
 * The token is minted at checkout, because that is the first moment a guest owns
 * anything on the server. It then identifies them for the life of the order:
 * order, payment and shipment all carry it, and `ownsRecord` compares against
 * it. Nothing else mints one, so a caller who has never placed an order has no
 * identity and consequently owns nothing.
 */
export function guestCookieOptions(isProduction: boolean): CookieOptions {
  return {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    // Only over HTTPS in production; local development is plain HTTP.
    secure: isProduction,
    maxAge: GUEST_COOKIE_TTL_MS,
    path: '/',
  };
}

/** Read the guest token from the signed cookie, if the client presented a valid one. */
export function readGuestToken(request: Request): string | undefined {
  const value: unknown = request.signedCookies?.[GUEST_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function newGuestToken(): string {
  return randomBytes(24).toString('base64url');
}

export function setGuestCookie(response: Response, token: string, isProduction: boolean): void {
  response.cookie(GUEST_COOKIE, token, guestCookieOptions(isProduction));
}
