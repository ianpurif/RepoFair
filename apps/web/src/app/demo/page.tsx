import { AppShell } from '../../components/app-shell';
import { Workspace } from '../../components/workspace';
import { notFound } from 'next/navigation';
import { fixturesEnabled } from '../api/fixture-boundary';
export const dynamic = 'force-dynamic';
export default function DemoPage() {
  if (!fixturesEnabled()) notFound();
  return <AppShell><Workspace initialFixture="jobboard-app@1.0.0" demo /></AppShell>;
}
