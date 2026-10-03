import { notFound } from 'next/navigation';
import { Workspace } from '../../../../components/workspace';
import { fixtures } from '../../../../lib/local-client';
export default async function RepositoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fixture = fixtures.find(item => item.id === id || item.name === id);
  if (!fixture) notFound();
  return <Workspace initialFixture={fixture.id} />;
}
