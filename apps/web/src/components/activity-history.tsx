'use client';
import { useEffect, useState } from 'react';
import type { Activity } from '@atlas/contracts';
import { Activity as ActivityIcon, CheckCircle2, CircleAlert, Clock3, Trash2 } from 'lucide-react';
import { clearActivities, readActivities } from '../lib/local-client';
export function ActivityHistory() {
  const [activities, setActivities] = useState<Activity[]>([]);
  useEffect(() => { const refresh = () => setActivities(readActivities()); refresh(); window.addEventListener('atlas-activity', refresh); return () => window.removeEventListener('atlas-activity', refresh); }, []);
  return <section className="activity-history"><div className="section-toolbar"><span className="quiet-label">Actual operations in this browser session · {activities.length} recorded</span><button className="button secondary" disabled={activities.length === 0} onClick={clearActivities}><Trash2 size={14} /> Clear history</button></div>{activities.length === 0 ? <div className="empty-card"><ActivityIcon size={27} strokeWidth={1.3} /><h2>No activity in this session</h2><p>Index a fixture, inspect source, or retrieve evidence to see the actual operations here.</p></div> : <ol className="activity-list">{activities.map(activity => <li key={activity.id}><span className={`activity-indicator ${activity.status}`}>{activity.status === 'complete' ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}</span><div className="activity-body"><div><strong>{activity.operation}</strong><span className="status-tag">{activity.status}</span></div><p>{activity.detail}</p><small><Clock3 size={12} />{new Date(activity.startedAt).toLocaleString()} <span>· {activity.durationMs} ms</span></small></div></li>)}</ol>}<p className="page-footnote">Local display operations and browser request timings are labeled separately from server retrieval timings. This history contains no agent reasoning narrative or payment receipts.</p></section>;
}
