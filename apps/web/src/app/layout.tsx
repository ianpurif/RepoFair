import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { ThemeProvider } from '../components/theme-provider';
export const metadata: Metadata = {
  title: 'Chronos Atlas · Codebase workspace',
  description: 'General codebase intelligence and independently operated knowledge providers.',
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" suppressHydrationWarning><body><ThemeProvider><a className="skip-link" href="#main">Skip to content</a>{children}</ThemeProvider></body></html>;
}
