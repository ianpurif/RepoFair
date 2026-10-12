import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { RepoFairLogo } from '../../components/app-shell';
import { ThemeToggle } from '../../components/theme-provider';
import { AuthPanel, AuthStatus } from '../../components/auth-status';
import { privatePageMetadata } from '../../lib/site-metadata';
export const metadata = privatePageMetadata('Sign in');
export default function SignInPage() {
  const fixtures = process.env.ATLAS_FIXTURES_ENABLED === 'true' && process.env.NODE_ENV !== 'production';
  return <main id="main" className="sign-in-page"><header className="landing-header"><RepoFairLogo /><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><AuthStatus /><ThemeToggle /></div></header><section className="sign-in-card" style={{ maxWidth: 460, padding: 24 }}><h1>Your codebase workspace</h1><p>Sign in to access your repositories.</p><AuthPanel mode="sign-in" />{fixtures && <><div className="sign-in-divider" /><span className="status-tag fixture">Development fixtures</span><Link className="button secondary" href="/demo">Explore the public fixtures <ArrowRight size={15} /></Link></>}</section></main>;
}
