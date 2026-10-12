import Link from 'next/link';
import { AtlasLogo } from '../components/app-shell';

export default function NotFound() {
  return <main id="main" className="landing">
    <header className="landing-header"><AtlasLogo /></header>
    <section className="sign-in-card" style={{ maxWidth: 460 }}><span className="eyebrow">404</span><h1>Page not found</h1><p>The requested page is unavailable. Return home or open your workspace to navigate to a repository you can access.</p><Link href="/" className="button primary">Return home</Link><Link href="/app" className="button secondary">Open workspace</Link></section>
  </main>;
}
