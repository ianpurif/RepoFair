import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AtlasLogo } from '../../components/app-shell';
import { ThemeToggle } from '../../components/theme-provider';
import { AuthPanel, AuthStatus } from '../../components/auth-status';
export default function SignInPage() {
  return <main id="main" className="sign-in-page"><header className="landing-header"><AtlasLogo /><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><AuthStatus /><ThemeToggle /></div></header><section className="sign-in-card" style={{ maxWidth: 460, padding: 24 }}><h1>Your codebase workspace</h1><p>Sign in to access repositories authorized for your account.</p><AuthPanel mode="sign-in" /><div className="sign-in-divider" /><span className="status-tag fixture">Public fixtures</span><p>The supplied example repositories are available without an account.</p><Link className="button secondary" href="/demo">Explore the public fixtures <ArrowRight size={15} /></Link></section></main>;
}
