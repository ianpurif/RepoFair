import Link from 'next/link';
import { ArrowRight, FileCode2, GitBranch, Link2 } from 'lucide-react';
import { AtlasLogo } from '../components/app-shell';
import { ThemeToggle } from '../components/theme-provider';

export default function Home() {
  const fixtures = process.env.ATLAS_FIXTURES_ENABLED === 'true' && process.env.NODE_ENV !== 'production';
  return <main id="main" className="landing">
    <header className="landing-header"><AtlasLogo /><nav aria-label="Main">{fixtures && <Link href="/demo">Development fixtures</Link>}<ThemeToggle /><Link href="/app" className="button secondary">Open workspace <ArrowRight size={15} /></Link></nav></header>
    <section className="landing-hero"><span className="eyebrow">Codebase intelligence, grounded in source</span><h1>Map your code.<br /><span>Connect the knowledge.</span></h1><p>Explore your repository. Follow a question back to the files, symbols, and commit that support it.</p><div className="hero-actions"><Link href="/app" className="button primary">Open your workspace <ArrowRight size={17} /></Link><span className="quiet-label">GitHub repositories · Tempo testnet</span></div></section>
    <section className="landing-features" aria-label="Workspace capabilities"><article><GitBranch size={21} /><h2>A map you can inspect</h2><p>Navigate parsed imports, declarations, and references. Expand one neighborhood at a time.</p></article><article><FileCode2 size={21} /><h2>Every source, in context</h2><p>Open original lines at an immutable commit. Keep exact package versions visible.</p></article><article><Link2 size={21} /><h2>Independent knowledge</h2><p>Publish selected source and review terms from independently operated knowledge providers.</p></article></section>
    <footer className="landing-footer"><span>Chronos Atlas</span><span>Tempo Moderato testnet · chain 42431</span><Link href="/app/settings">Settings</Link></footer>
  </main>;
}
