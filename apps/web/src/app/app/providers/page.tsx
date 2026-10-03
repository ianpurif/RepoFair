import Link from 'next/link';
import { ArrowUpRight, Box } from 'lucide-react';
import { PageHeader } from '../../../components/app-shell';
import { ProviderDirectory } from '../../../components/provider-directory';
export default function ProvidersPage() {
  return <main id="main" className="content-page"><PageHeader title="Knowledge providers" subtitle="Version-specific context from independently operated services." /><ProviderDirectory /><section className="local-alternatives"><h2>Explore the dependency source locally</h2><p>These are original fixture repositories. They are available for direct inspection without a purchase.</p><div className="fixture-links"><Link href="/app/repositories/retry-kit%401.0.0"><Box size={18} /><span>retry-kit <small>1.0.0 · local fixture</small></span><ArrowUpRight size={15} /></Link><Link href="/app/repositories/retry-kit%402.0.0"><Box size={18} /><span>retry-kit <small>2.0.0 · local fixture</small></span><ArrowUpRight size={15} /></Link><Link href="/app/repositories/event-log%401.0.0"><Box size={18} /><span>event-log <small>1.0.0 · local fixture</small></span><ArrowUpRight size={15} /></Link></div></section></main>;
}
