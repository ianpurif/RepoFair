import { Check, Eye, GitBranch, ShieldCheck, Upload } from 'lucide-react';
import { PageHeader } from '../../../components/app-shell';
export default function PublishPage() {
  return <main id="main" className="content-page"><PageHeader title="Publish a knowledge service" subtitle="Share an authorized repository snapshot through your own provider." /><div className="notice"><ShieldCheck size={19} /><div><strong>Publishing is unavailable</strong><p>Repository administration and endpoint control have not been connected. Read access alone cannot authorize publication.</p></div><span className="status-tag unavailable">Setup required</span></div><section className="publishing-flow" aria-label="Required publishing steps">{[
    { Icon: ShieldCheck, title: 'Verify repository rights', detail: 'Connect identity and verify administrative permission. Declare your rights to the content.' },
    { Icon: GitBranch, title: 'Choose an exact snapshot', detail: 'Bind package releases and exports to an immutable source revision.' },
    { Icon: Eye, title: 'Review exposed source', detail: 'Preview paths and access policy. Private source is never exposed by default.' },
    { Icon: Check, title: 'Confirm terms and recipient', detail: 'Review the fixed operation, integer price, token, network, recipient, and service limits.' },
  ].map(({ Icon, title, detail }, i) => <article key={title}><span className="step-number">{i + 1}</span><Icon size={18} /><div><h2>{title}</h2><p>{detail}</p></div><span className="quiet-label">Unavailable</span></article>)}</section><button className="button primary" disabled aria-describedby="publish-unavailable"><Upload size={15} /> Publish service</button><p id="publish-unavailable" className="page-footnote">Publication stays disabled until ownership, exposure review, and provider configuration are verified.</p></main>;
}
