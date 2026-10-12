import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';
import { ThemeProvider } from '../components/theme-provider';
import { AuthAvailabilityProvider, type AuthAvailability } from '../components/auth-status';
import { rootMetadata } from '../lib/site-metadata';
export const metadata = rootMetadata();
export default function RootLayout({ children }: { children: ReactNode }) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  const keyMatch = publishableKey?.match(/^pk_(test|live)_([A-Za-z0-9+/=]+)$/);
  const secretMatch = secretKey?.match(/^sk_(test|live)_[A-Za-z0-9]{10,}$/);
  let validPublishableKey = false;
  if (keyMatch?.[2]) {
    const frontendHost = Buffer.from(keyMatch[2], 'base64').toString('utf8');
    validPublishableKey = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}\$$/i.test(frontendHost);
  }
  const configured = validPublishableKey && !!secretMatch && keyMatch?.[1] === secretMatch[1];
  const availability: AuthAvailability = {
    configured,
    environment: configured ? (keyMatch?.[1] === 'test' ? 'development' : 'production') : null,
    issue: configured ? null : (!publishableKey || !secretKey ? 'missing' : 'invalid'),
  };
  const content = <AuthAvailabilityProvider value={availability}><ThemeProvider><a className="skip-link" href="#main">Skip to content</a>{children}</ThemeProvider></AuthAvailabilityProvider>;
  return <html lang="en" suppressHydrationWarning><body>{configured && publishableKey ? <ClerkProvider publishableKey={publishableKey} signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/app" signUpFallbackRedirectUrl="/app">{content}</ClerkProvider> : content}</body></html>;
}
