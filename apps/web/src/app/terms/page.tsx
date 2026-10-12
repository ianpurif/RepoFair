import Link from 'next/link';
import { AtlasLogo } from '../../components/app-shell';
import { ThemeToggle } from '../../components/theme-provider';
import { publicPageMetadata } from '../../lib/site-metadata';

export const metadata = publicPageMetadata('/terms', 'Use and payment terms', 'Repository authorization, source evidence limits, independent provider terms, and Tempo Moderato testnet purchases in Chronos Atlas.');

export default function TermsPage() {
  return <main id="main" className="landing">
    <header className="landing-header"><AtlasLogo /><nav aria-label="Main"><ThemeToggle /><Link href="/app" className="button secondary">Open workspace</Link></nav></header>
    <article className="content-page" style={{ maxWidth: 760, paddingLeft: 0, paddingRight: 0 }}>
      <header className="page-header"><div><span className="eyebrow">Public information</span><h1>Use and payment terms</h1><p>Review repository permissions, publication exposure, and each provider’s exact terms before proceeding.</p></div></header>
      <div style={{ display: 'grid', gap: 28, lineHeight: 1.9 }}>
        <section><h2 style={{ fontSize: 16 }}>Authorized use</h2><p>Use Atlas only with repositories and source you are permitted to access. Keep credentials, personal information, and secrets out of published material. Reading a repository does not grant publishing rights. Publishing requires repository administrative authority and a declaration of your content rights.</p></section>
        <section><h2 style={{ fontSize: 16 }}>Source and evidence limits</h2><p>Maps describe parsed TypeScript and JavaScript relationships at an immutable commit. Static reachability indicates potential impact, rather than confirmed runtime breakage. Citations identify source locations; they do not establish that an interpretation is correct. Unsupported references and insufficient evidence remain explicit.</p></section>
        <section><h2 style={{ fontSize: 16 }}>Independent services</h2><p>Provider context has its own operator, provenance, package version, access policy, and licensing information. Endpoint control, repository administration, content rights, and evidence accuracy are separate claims. Paying for a response does not verify its accuracy or grant rights beyond the provider’s stated access and license terms.</p></section>
        <section><h2 style={{ fontSize: 16 }}>Testnet purchases</h2><p>Atlas uses Tempo Moderato testnet, chain 42431. Review the fixed operation, package version, amount, asset, recipient, expiry, and request disclosure. A purchase requires an approved spending allowance and explicit wallet authorization. Mainnet payments are unavailable.</p><p style={{ marginTop: 10 }}>Payment, delivery, and evidence quality have separate statuses. If settlement is unknown, use the recorded recovery operation; do not approve a new charge to retry the same purchase. A settled payment does not guarantee delivery or sufficient evidence. The application does not implement automatic refunds.</p></section>
        <section><h2 style={{ fontSize: 16 }}>Publication and revocation</h2><p>Review the exact exposed source before exporting a publication. Revocation stops new access but cannot recall copies already delivered. Source owners retain their existing rights; publication does not make public source proprietary.</p></section>
        <section><h2 style={{ fontSize: 16 }}>Availability and account control</h2><p>Repository access, provider availability, supported versions, and configured integration limits can change. A failed or unavailable service is reported explicitly. Do not bypass access controls, submit malicious imports, or treat an unavailable feature as a successful operation. Manage GitHub access and your account from the workspace and the connected identity services.</p></section>
      </div>
    </article>
    <footer className="landing-footer"><Link href="/">Chronos Atlas</Link><Link href="/privacy">Privacy</Link><Link href="/app/settings">Account settings</Link></footer>
  </main>;
}
