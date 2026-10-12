import Link from 'next/link';
import { ArrowRight, FileCode2, GitBranch, Link2 } from 'lucide-react';
import { AtlasLogo } from '../components/app-shell';
import { ThemeToggle } from '../components/theme-provider';
import { publicPageMetadata, SITE_TITLE, SITE_DESCRIPTION } from '../lib/site-metadata';

export const metadata = publicPageMetadata('/', SITE_TITLE, SITE_DESCRIPTION);

export default function Home() {
  const fixtures = process.env.ATLAS_FIXTURES_ENABLED === 'true' && process.env.NODE_ENV !== 'production';
  return <main id="main" className="landing">
    <header className="landing-header"><AtlasLogo /><nav aria-label="Main">{fixtures && <Link href="/demo">Development fixtures</Link>}<ThemeToggle /><Link href="/app" className="button secondary">Open workspace <ArrowRight size={15} /></Link></nav></header>
    <section className="landing-hero"><span className="eyebrow">Codebase intelligence, grounded in source</span><h1>Map your code.<br /><span>Connect the knowledge.</span></h1><p>Explore your repository. Follow a question back to the files, symbols, and commit that support it.</p><div className="hero-actions"><Link href="/app" className="button primary">Open your workspace <ArrowRight size={17} /></Link><span className="quiet-label">GitHub repositories · Tempo testnet</span></div></section>
    <section className="landing-features" aria-label="Workspace capabilities"><article><GitBranch size={21} /><h2>A map you can inspect</h2><p>Navigate parsed TypeScript and JavaScript imports, declarations, and references. Expand one neighborhood at a time. Static relationships show potential impact.</p></article><article><FileCode2 size={21} /><h2>Every source, in context</h2><p>Open original lines at an immutable commit. Search your indexed source and follow extractive answers to their citations.</p></article><article><Link2 size={21} /><h2>Independent knowledge</h2><p>Review selected source, exact package versions, access, and price before publishing or purchasing provider context. Payment does not verify its accuracy.</p></article></section>
    <p className="page-footnote" style={{ margin: '0 0 28px', maxWidth: 680 }}>Repository access requires sign-in and GitHub authorization. Provider purchases use Tempo Moderato testnet, chain 42431, with an explicit allowance and wallet approval. This application does not offer mainnet payments.</p>
    <footer className="landing-footer"><span>Chronos Atlas</span><span>Tempo Moderato testnet · chain 42431</span><nav aria-label="Public information" style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></nav></footer>
  </main>;
}
