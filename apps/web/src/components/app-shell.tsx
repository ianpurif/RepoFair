'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, ArrowUpRight, Boxes, GitBranch, Layers3, Settings2, Upload } from 'lucide-react';
import type { ReactNode } from 'react';
import { AuthStatus } from './auth-status';
import { ThemeToggle } from './theme-provider';

const links = [
  { href: '/app', title: 'Workspace', icon: GitBranch },
  { href: '/app/repositories', title: 'Repositories', icon: Layers3 },
  { href: '/app/providers', title: 'Providers', icon: Boxes },
  { href: '/app/publish', title: 'Publish', icon: Upload },
  { href: '/app/activity', title: 'Activity', icon: Activity },
  { href: '/app/settings', title: 'Settings', icon: Settings2 },
];
export function RepoFairLogo({ compact = false }: { compact?: boolean }) {
  return <Link href="/" className="brand" aria-label="RepoFair home"><span className="brand-icon"><Layers3 size={19} strokeWidth={1.65} /></span>{!compact && <span>Repo<strong>Fair</strong></span>}</Link>;
}
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return <div className="app-shell"><aside className="app-rail"><RepoFairLogo compact /><nav aria-label="Application">{links.map(({ href, title, icon: Icon }) => {
    const active = href === '/app' ? path === href || path.startsWith('/app/repositories/') || path === '/demo' : path.startsWith(href);
    return <Link key={href} href={href} className={`rail-link ${active ? 'active' : ''}`} aria-label={title} title={title} aria-current={active ? 'page' : undefined}><Icon size={19} strokeWidth={1.7} /><span>{title}</span></Link>;
  })}</nav><div className="rail-bottom"><ThemeToggle /><AuthStatus /></div></aside><div className="app-content">{children}</div></div>;
}
export function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return <header className="page-header"><div><h1>{title}</h1><p>{subtitle}</p></div><Link className="button secondary" href="/app">Open workspace <ArrowUpRight size={15} /></Link></header>;
}
export function Unavailable({ title, detail }: { title: string; detail: string }) {
  return <div className="unavailable-state"><span className="status-tag unavailable">Unavailable</span><h2>{title}</h2><p>{detail}</p><Link className="button secondary" href="/app/repositories">Open repositories <ArrowUpRight size={15} /></Link></div>;
}
