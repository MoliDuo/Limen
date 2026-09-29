import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import {
  readSession,
  renewSession,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  shouldRenewSession,
} from '@/lib/auth/session';
import { loginPath, stripLegacyLocalePath } from '@/lib/pathname';
import {
  applySecurityHeaders,
  buildContentSecurityPolicy,
  createRequestNonce,
} from '@/lib/auth/response-security';

type ProxyDecisionInput = {
  pathname: string;
  hasSession: boolean;
};

type ProxyDecision =
  | { type: 'json'; status: number; body: { error: string } }
  | { type: 'redirect'; location: string }
  | { type: 'next' };

// Served from the app root by Next's metadata files. The manifest and icons are
// fetched without credentials during a PWA install, so redirecting them to
// /login would break "add to home screen" outright.
const PUBLIC_ASSET_PATHS = new Set([
  '/favicon.ico',
  '/robots.txt',
  '/manifest.webmanifest',
  '/icon.svg',
  '/apple-icon.png',
]);

export function shouldBypassProxy(pathname: string) {
  return (
    pathname.startsWith('/_next/static/') ||
    pathname.startsWith('/_next/image/') ||
    pathname.startsWith('/api/') ||
    PUBLIC_ASSET_PATHS.has(pathname)
  );
}

export function evaluateProxyRequest({
  pathname,
  hasSession,
}: ProxyDecisionInput): ProxyDecision {
  if (shouldBypassProxy(pathname)) return { type: 'next' };

  const normalizedPath = stripLegacyLocalePath(pathname);
  if (normalizedPath !== pathname)
    return { type: 'redirect', location: normalizedPath };
  if (pathname === '/login') {
    return hasSession ? { type: 'redirect', location: '/' } : { type: 'next' };
  }
  return hasSession
    ? { type: 'next' }
    : { type: 'redirect', location: loginPath() };
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (shouldBypassProxy(pathname)) return NextResponse.next();

  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await readSession(db, cookie);
  const decision = evaluateProxyRequest({
    pathname,
    hasSession: Boolean(session),
  });
  const nonce = createRequestNonce();
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', contentSecurityPolicy);

  let response: NextResponse;
  if (decision.type === 'json') {
    response = NextResponse.json(decision.body, { status: decision.status });
  } else if (decision.type === 'redirect') {
    response = NextResponse.redirect(new URL(decision.location, request.url));
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }
  if (session && cookie && shouldRenewSession(session)) {
    // Sliding expiry: an active reader never hits the 7-day wall.
    response.cookies.set(
      SESSION_COOKIE_NAME,
      cookie,
      sessionCookieOptions(await renewSession(db, session)),
    );
  } else if (!session && cookie) {
    // Signed out elsewhere, expired or tampered: drop it so the browser stops
    // sending it.
    response.cookies.set(
      SESSION_COOKIE_NAME,
      '',
      sessionCookieOptions(new Date(0)),
    );
  }

  applySecurityHeaders(response.headers, contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
