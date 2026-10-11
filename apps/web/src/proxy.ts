import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';

const isProtectedApi = (pathname: string) => ['/api/account', '/api/repositories', '/api/publications','/api/catalog','/api/purchases'].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
const secretKey = process.env.CLERK_SECRET_KEY?.trim();
const keyMatch = publishableKey?.match(/^pk_(test|live)_([A-Za-z0-9+/=]+)$/);
const secretMatch = secretKey?.match(/^sk_(test|live)_[A-Za-z0-9]{10,}$/);
const frontendHost = keyMatch?.[2] ? Buffer.from(keyMatch[2], 'base64').toString('utf8') : '';
const configured = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}\$$/i.test(frontendHost) && !!secretMatch && keyMatch?.[1] === secretMatch[1];

// Use static environment keys; explicit key overrides require Clerk's encrypted dynamic-key transport.
const authenticatedProxy = configured && publishableKey && secretKey ? clerkMiddleware(async (auth, request) => {
  if (!isProtectedApi(request.nextUrl.pathname)) return;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to access your workspace.' } }, { status: 401, headers: { 'Cache-Control': 'no-store', Vary: 'Cookie, Authorization' } });
}) : null;

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (authenticatedProxy) return authenticatedProxy(request, event);
  if (isProtectedApi(request.nextUrl.pathname)) return NextResponse.json({ error: { code: 'AUTHENTICATION_UNAVAILABLE', message: 'Clerk authentication configuration is missing or invalid.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
};
