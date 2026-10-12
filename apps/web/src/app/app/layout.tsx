import type { ReactNode } from 'react';
import { AppShell } from '../../components/app-shell';
import { privatePageMetadata } from '../../lib/site-metadata';
export const metadata = privatePageMetadata('Workspace');
export default function ApplicationLayout({ children }: { children: ReactNode }) { return <AppShell>{children}</AppShell>; }
