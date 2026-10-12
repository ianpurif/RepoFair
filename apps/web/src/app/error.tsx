'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';

export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <main id="main" className="landing"><section className="sign-in-card" role="alert" style={{ maxWidth: 460 }}><h1 ref={heading} tabIndex={-1}>This page could not load</h1><p>Try loading the page again or return home. If a payment was interrupted, check its recorded status in Activity before approving another purchase.</p><button className="button primary" onClick={reset}>Try again</button><Link href="/" className="button secondary">Return home</Link><Link href="/app/activity" className="button secondary">Open activity</Link></section></main>;
}
