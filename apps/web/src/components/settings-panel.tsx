'use client';
import Link from 'next/link';
import { ArrowRight, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from './theme-provider';

export function SettingsPanel() {
  const { theme, setTheme } = useTheme();
  return <div className="settings-sections"><section className="settings-card"><div><h2>Appearance</h2><p>Choose a theme or follow your system preference.</p></div><div className="theme-options">{([{ id: 'system', label: 'System', Icon: Monitor }, { id: 'light', label: 'Light', Icon: Sun }, { id: 'dark', label: 'Dark', Icon: Moon }] as const).map(({ id, label, Icon }) => <button key={id} className={theme === id ? 'active' : ''} aria-pressed={theme === id} onClick={() => setTheme(id)}><Icon size={18} />{label}</button>)}</div></section>
    <section className="settings-card"><div><h2>GitHub connection</h2><p>Manage connected accounts and repository access from Repositories.</p></div><Link className="button secondary" href="/app/repositories">Open repositories <ArrowRight size={14} /></Link></section>
    <section className="settings-card"><div><h2>Payments network</h2><p>Tempo Moderato testnet · chain 42431. Purchases require exact terms, a spending allowance, and explicit signing approval.</p></div><span className="status-tag">Testnet</span></section>
    <section className="settings-card"><div><h2>Knowledge services</h2><p>Review selected source and saved terms before publishing a service.</p></div><Link className="button secondary" href="/app/publish">Manage publishing <ArrowRight size={14} /></Link></section>
  </div>;
}
