import { PageHeader } from '../../../../components/app-shell';
import { ProviderDirectory } from '../../../../components/provider-directory';
export default async function ProviderPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <main id="main" className="content-page"><PageHeader title="Provider context" subtitle="Provider identity, exact releases, and source provenance." /><ProviderDirectory providerId={id} /></main>; }
