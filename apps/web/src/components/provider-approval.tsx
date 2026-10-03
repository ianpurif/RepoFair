'use client';
import { useEffect, useRef, useState } from 'react';
import type { FederationResult, FixtureId, FixtureProviderInfo, LocalIndex } from '@atlas/contracts';
import { ArrowUpRight, Box, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import { discoverProviders, retrieveProviders } from '../lib/local-client';

export function ProviderApproval({ fixtureId, index, onResult, onActivity, onBusy }: { fixtureId: FixtureId; index: LocalIndex; onResult: (result: FederationResult) => void; onActivity: (status: 'complete' | 'failed', startedAt: string, durationMs: number, detail: string) => void; onBusy: (busy: boolean) => void }) {
  const [providers, setProviders] = useState<FixtureProviderInfo[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [externalQuestion, setExternalQuestion] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const requestAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null); setSelected(new Set());
    discoverProviders(controller.signal).then(result => { if (!controller.signal.aborted) { setProviders(result); setLoading(false); } }).catch(error => { if (!controller.signal.aborted) { setLoading(false); setError(error instanceof Error ? error.message : 'Provider discovery failed.'); } });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => { return () => { requestAbort.current?.abort(); onBusy(false); }; }, [onBusy]);
  async function retrieve() {
    if (!selected.size || !externalQuestion.trim() || busy) return;
    const controller = new AbortController(); requestAbort.current = controller;
    setBusy(true); onBusy(true); setError(null); const startedAt = new Date().toISOString(); const start = performance.now();
    try {
      const result = await retrieveProviders(fixtureId, [...selected], externalQuestion.trim(), controller.signal);
      if (controller.signal.aborted) return;
      onResult(result); onActivity('complete', startedAt, performance.now() - start, `${result.providers.map(provider => `${provider.providerId} · ${provider.index.version}`).join(', ')}. Actual local HTTP fixture requests. Payment not attempted. Browser request duration.`);
    } catch (error) {
      if (controller.signal.aborted) return;
      const detail = error instanceof Error ? error.message : 'Provider retrieval failed. No payment was attempted.'; setError(detail); onActivity('failed', startedAt, performance.now() - start, detail);
    } finally { if (!controller.signal.aborted) { setBusy(false); onBusy(false); } }
  }
  return <section className="provider-approval"><div className="provider-approval-heading"><h3><Box size={14} /> Extend with provider source</h3><button className="icon-button" disabled={loading || busy} onClick={() => setRefresh(value => value + 1)} aria-label="Refresh local provider availability"><RefreshCw size={13} /></button></div><p>Approve one or two separately configured local fixture services. Payments are disabled.</p>
    {loading ? <div className="provider-loading" role="status"><LoaderCircle size={15} className="spin" /> Discovering local endpoints…</div> : providers.map(provider => {
      const binding = index.dependencies.find(item => item.packageName === provider.packageName && item.status === 'exact');
      const match = !!binding?.version && provider.versions.includes(binding.version);
      const available = provider.published && match;
      return <label className={`provider-choice ${selected.has(provider.providerId) ? 'selected' : ''}`} key={provider.providerId}><input type="checkbox" checked={selected.has(provider.providerId)} disabled={!available || busy} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(provider.providerId); else next.delete(provider.providerId); return next; })} /><span><strong>{provider.providerId}</strong><small>{provider.packageName} · {binding?.version ?? 'No exact local binding'}</small><small>{provider.endpoint}</small><em>{!provider.published ? 'Unavailable · local process not ready' : !match ? 'Unavailable · no matching dependency version' : 'Available · real local HTTP fixture'}</em></span></label>;
    })}
    {!loading && providers.length === 0 && !error && <p>No registered local providers were returned.</p>}
    <label className="external-question-label" htmlFor="external-question">Question to send to selected providers</label><textarea id="external-question" rows={3} value={externalQuestion} maxLength={2000} disabled={busy} onChange={event => setExternalQuestion(event.target.value)} placeholder="Write the bounded public dependency question to share." />
    <div className="disclosure-preview"><strong>Disclosure preview</strong><span>Only this external question, the selected package identity, and its exact version leave the workspace.</span><span>Local source and the local question are not forwarded.</span><span>Price: unavailable · payment disabled · recipient: none</span></div>
    {error && <p className="provider-error" role="alert"><CircleAlert size={14} />{error}</p>}
    <button className="button secondary" disabled={busy || selected.size === 0 || selected.size > 2 || !externalQuestion.trim()} onClick={() => void retrieve()}>{busy ? <LoaderCircle className="spin" size={14} /> : <ArrowUpRight size={14} />}{busy ? 'Requesting fixture context…' : `Approve ${selected.size || ''}${selected.size ? ' ' : ''}fixture request${selected.size === 1 ? '' : 's'}`}</button><small className="provider-payment-note">No payment, receipt, or live publication is represented by this action.</small>
  </section>;
}
