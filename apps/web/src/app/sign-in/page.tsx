import Link from 'next/link';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import { AtlasLogo } from '../../components/app-shell';
import { ThemeToggle } from '../../components/theme-provider';
export default function SignInPage() {
  return <main id="main" className="sign-in-page"><header className="landing-header"><AtlasLogo /><ThemeToggle /></header><section className="sign-in-card"><span className="sign-in-icon"><LockKeyhole size={24} strokeWidth={1.4} /></span><h1>Your codebase workspace</h1><p>Sign-in is unavailable while Clerk and workspace authorization are being connected.</p><button className="button secondary" disabled aria-describedby="sign-in-status">Continue with Google</button><small id="sign-in-status">Authentication setup required.</small><div className="sign-in-divider" /><p>The original local fixtures are available without an account.</p><Link className="button primary" href="/app">Explore the fixtures <ArrowRight size={15} /></Link></section></main>;
}
