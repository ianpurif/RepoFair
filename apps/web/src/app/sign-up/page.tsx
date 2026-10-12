import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AtlasLogo } from '../../components/app-shell';
import { ThemeToggle } from '../../components/theme-provider';
import { AuthPanel, AuthStatus } from '../../components/auth-status';
import { privatePageMetadata } from '../../lib/site-metadata';
export const metadata = privatePageMetadata('Create an account');

export default function SignUpPage() {
  const fixtures = process.env.ATLAS_FIXTURES_ENABLED === 'true' && process.env.NODE_ENV !== 'production';
  return <main id="main" className="sign-in-page"><header className="landing-header"><AtlasLogo /><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><AuthStatus /><ThemeToggle /></div></header><section className="sign-in-card" style={{ maxWidth: 460, padding: 24 }}><h1>Create your Atlas account</h1><p>Access your repositories and workspace.</p><AuthPanel mode="sign-up" />{fixtures && <><div className="sign-in-divider" /><span className="status-tag fixture">Development fixtures</span><Link className="button secondary" href="/demo">Explore the public fixtures <ArrowRight size={15} /></Link></>}</section></main>;
}
