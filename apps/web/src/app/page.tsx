import Link from 'next/link';
import { ArrowRight, FileCode2, GitBranch, Link2 } from 'lucide-react';
import { AtlasLogo } from '../components/app-shell';
import { ThemeToggle } from '../components/theme-provider';

export default function Home() {
  return <main id="main" className="landing">
    <header className="landing-header"><AtlasLogo /><nav aria-label="Main"><Link href="/demo">Try the fixtures</Link><ThemeToggle /><Link href="/app" className="button secondary">Open workspace <ArrowRight size={15} /></Link></nav></header>
    <section className="landing-hero"><span className="eyebrow"><span className="status-dot" /> Codebase intelligence, grounded in source</span><h1>Map your code.<br /><span>Connect the knowledge.</span></h1><p>Explore the relationships in your repository. Follow a question back to the files, symbols, and exact version that support it.</p><div className="hero-actions"><Link href="/app" className="button primary">Explore the workspace <ArrowRight size={17} /></Link><span className="quiet-label">Local fixtures · no account needed</span></div></section>
    <section className="landing-features" aria-label="Workspace capabilities"><article><GitBranch size={21} /><h2>A map you can inspect</h2><p>Navigate parsed imports, exports, and calls. Expand one neighborhood at a time.</p></article><article><FileCode2 size={21} /><h2>Every source, in context</h2><p>Open original lines in an immutable snapshot. Keep exact package versions visible.</p></article><article><Link2 size={21} /><h2>Independent knowledge</h2><p>Provider publishing and approved Tempo purchases are planned integrations. They remain unavailable in this local slice.</p></article></section>
    <footer className="landing-footer"><span>Chronos Atlas</span><span>Fixture mode · source extraction is available; generated answers and live payments are unavailable.</span><Link href="/app/settings">Integration status</Link></footer>
  </main>;
}
