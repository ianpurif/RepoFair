import { starterCapabilities } from '@atlas/core';
export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json(starterCapabilities(), { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
