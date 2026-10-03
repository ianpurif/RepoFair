import { applicationCapabilities } from '@atlas/core';
export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json(applicationCapabilities(), { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
