import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AtlasLogo } from '../../components/app-shell';
import { ThemeToggle } from '../../components/theme-provider';
import { AuthPanel, AuthStatus } from '../../components/auth-status';

export default function SignUpPage() {
  return <main id="main" className="sign-in-page"><header className="landing-header"><AtlasLogo /><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><AuthStatus /><ThemeToggle /></div></header><section className="sign-in-card" style={{ maxWidth: 460, padding: 24 }}><h1>Create your Atlas account</h1><p>Your account identifies access to your repositories and workspace.</p><AuthPanel mode="sign-up" /><div className="sign-in-divider" /><span className="status-tag fixture">Public fixtures</span><Link className="button secondary" href="/demo">Explore the public fixtures <ArrowRight size={15} /></Link></section></main>;
}
