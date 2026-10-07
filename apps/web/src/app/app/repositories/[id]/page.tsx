import { notFound } from 'next/navigation';
import { Workspace } from '../../../../components/workspace';
import { fixtures } from '../../../../lib/local-client';
import { RepositoryWorkspace } from '../../../../components/repository-workspace';
const repositoryUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export default async function RepositoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fixture = fixtures.find(item => item.id === id || item.name === id);
  if (fixture) return <Workspace initialFixture={fixture.id} />;
  if (repositoryUuid.test(id)) return <RepositoryWorkspace repositoryId={id} />;
  notFound();
}
