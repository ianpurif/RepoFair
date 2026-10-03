'use client';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from './theme-provider';
export function SettingsPanel() {
  const { theme, setTheme } = useTheme();
  return <div className="settings-sections"><section className="settings-card"><div><h2>Appearance</h2><p>Choose a theme or follow your system preference.</p></div><div className="theme-options">{([{ id: 'system', label: 'System', Icon: Monitor }, { id: 'light', label: 'Light', Icon: Sun }, { id: 'dark', label: 'Dark', Icon: Moon }] as const).map(({ id, label, Icon }) => <button key={id} className={theme === id ? 'active' : ''} aria-pressed={theme === id} onClick={() => setTheme(id)}><Icon size={18} />{label}</button>)}</div></section>
    <section className="settings-card"><div><h2>Development mode</h2><p>Original fixture repositories with immutable source revisions.</p></div><span className="status-tag fixture">Fixture</span></section>
    <section className="settings-card integrations"><div><h2>Integration status</h2><p>External operations require separately verified setup.</p></div><dl>{[
      ['Fixture graph and source', 'Available through local APIs'],
      ['Local questions', 'Extractive retrieval; no generation model'],
      ['Local provider contexts', 'Fixture HTTP APIs; availability checked per request'],
      ['Clerk identity and organizations', 'Unavailable · authentication setup required'],
      ['GitHub import', 'Unavailable · authorized GitHub App required'],
      ['Private repositories', 'Unavailable · identity and tenant isolation required'],
      ['Provider publishing', 'Unavailable · owner authorization required'],
      ['Tempo purchases', 'Unavailable · payment setup and approval required'],
    ].map(([name, state]) => <div key={name}><dt>{name}</dt><dd>{state}</dd></div>)}</dl></section>
    <p className="page-footnote">Server credentials are configured outside the browser. No secret entry, wallet signing, or real-money operation is enabled here.</p>
  </div>;
}
