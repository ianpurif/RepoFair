'use client';

import { SignIn, SignUp, UserButton, useUser } from '@clerk/nextjs';
import Link from 'next/link';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface AuthAvailability {
  configured: boolean;
  environment: 'development' | 'production' | null;
  issue: 'missing' | 'invalid' | null;
}

const AuthAvailabilityContext = createContext<AuthAvailability>({ configured: false, environment: null, issue: 'missing' });

export function AuthAvailabilityProvider({ value, children }: { value: AuthAvailability; children: ReactNode }) {
  return <AuthAvailabilityContext.Provider value={value}>{children}</AuthAvailabilityContext.Provider>;
}

function AuthUnavailable({ issue }: { issue: AuthAvailability['issue'] }) {
  return <div role="status"><span className="status-tag unavailable">Authentication unavailable</span><p style={{ marginTop: 12 }}>{issue === 'invalid' ? 'Clerk configuration is invalid. Check the publishable key, secret key, and their matching environment.' : 'Clerk authentication is not configured. A publishable key and secret key are required.'}</p></div>;
}

function useAuthenticationTimeout(isLoaded: boolean) {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (isLoaded) return;
    const timer = window.setTimeout(() => setTimedOut(true), 20_000);
    return () => window.clearTimeout(timer);
  }, [isLoaded]);
  return !isLoaded && timedOut;
}

function SessionStatus() {
  const { isLoaded, isSignedIn, user } = useUser();
  const [workspaceError, setWorkspaceError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!isSignedIn || !user?.id) return;
    let active = true;
    fetch('/api/account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(response => { if (active) setWorkspaceError(!response.ok); })
      .catch(() => { if (active) setWorkspaceError(true); });
    return () => { active = false; };
  }, [isSignedIn, user?.id, attempt]);
  const serviceTimedOut = useAuthenticationTimeout(isLoaded);
  if (serviceTimedOut) return <Link href="/sign-in" className="quiet-label">Authentication unavailable</Link>;
  if (!isLoaded) return <span className="quiet-label" role="status">Loading account…</span>;
  if (!isSignedIn) return <Link href="/sign-in" className="button secondary">Sign in</Link>;
  return <div aria-label="Account menu">{workspaceError && <button className="button secondary" onClick={() => setAttempt(value => value + 1)}>Retry workspace setup</button>}<UserButton /></div>;
}

/** Only renders Clerk hooks inside a configured ClerkProvider. */
export function AuthStatus() {
  const { configured } = useContext(AuthAvailabilityContext);
  return configured ? <SessionStatus /> : <Link href="/sign-in" className="button secondary" aria-label="Authentication setup required">Sign in</Link>;
}

function ClerkAuthPanel({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const { isLoaded, isSignedIn } = useUser();
  const serviceTimedOut = useAuthenticationTimeout(isLoaded);
  if (serviceTimedOut) {
    return <div role="alert"><p>Authentication could not load. Check your connection and try again.</p><button className="button secondary" style={{ marginTop: 12 }} onClick={() => window.location.reload()}>Retry authentication</button></div>;
  }
  if (isSignedIn) return <div role="status"><p>You are signed in.</p><Link className="button primary" style={{ marginTop: 12 }} href="/app">Open your workspace</Link></div>;
  const appearance = {
    variables: { colorPrimary: 'var(--accent)', colorBackground: 'var(--surface)', colorText: 'var(--ink)', colorTextSecondary: 'var(--muted)', colorInputBackground: 'var(--surface)', colorInputText: 'var(--ink)' },
    elements: { rootBox: { width: '100%' }, cardBox: { width: '100%', boxShadow: 'none' }, card: { boxShadow: 'none', border: '1px solid var(--line)' } },
  };
  const fallback = <p role="status">Loading authentication…</p>;
  return mode === 'sign-in'
    ? <SignIn routing="hash" signUpUrl="/sign-up" fallbackRedirectUrl="/app" signUpFallbackRedirectUrl="/app" appearance={appearance} fallback={fallback} />
    : <SignUp routing="hash" signInUrl="/sign-in" fallbackRedirectUrl="/app" signInFallbackRedirectUrl="/app" appearance={appearance} fallback={fallback} />;
}

export function AuthPanel({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const { configured, issue, environment } = useContext(AuthAvailabilityContext);
  if (!configured) return <AuthUnavailable issue={issue} />;
  return <div style={{ width: '100%' }}>{environment === 'development' && <span className="status-tag" style={{ marginBottom: 14 }}>Development authentication</span>}<ClerkAuthPanel mode={mode} /></div>;
}
