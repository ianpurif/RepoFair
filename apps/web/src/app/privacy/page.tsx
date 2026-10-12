import Link from 'next/link';
import { AtlasLogo } from '../../components/app-shell';
import { ThemeToggle } from '../../components/theme-provider';
import { publicPageMetadata } from '../../lib/site-metadata';

export const metadata = publicPageMetadata('/privacy', 'Privacy and data use', 'How Chronos Atlas handles account identity, authorized repository source, provider requests, and testnet purchase records.');

export default function PrivacyPage() {
  return <main id="main" className="landing">
    <header className="landing-header"><AtlasLogo /><nav aria-label="Main"><ThemeToggle /><Link href="/app" className="button secondary">Open workspace</Link></nav></header>
    <article className="content-page" style={{ maxWidth: 760, paddingLeft: 0, paddingRight: 0 }}>
      <header className="page-header"><div><span className="eyebrow">Public information</span><h1>Privacy and data use</h1><p>This notice describes the application’s data flows. Only import or publish source you are authorized to use.</p></div></header>
      <div style={{ display: 'grid', gap: 28, lineHeight: 1.9 }}>
        <section><h2 style={{ fontSize: 16 }}>Accounts and repository access</h2><p>Clerk handles sign-in and session management. Atlas stores your account identifier and workspace membership to authorize requests. Connecting GitHub is a separate authorization step. GitHub credentials and server configuration are used on the server, rather than exposed to browser code.</p></section>
        <section><h2 style={{ fontSize: 16 }}>Imported code and history</h2><p>Authorized imports store supported source files, immutable commit identifiers, source digests, graph relationships, and job history in the configured database. Private source, maps, and citations require repository and workspace access. Importing a repository does not publish it. Atlas parses source without installing or running the imported project.</p><p style={{ marginTop: 10 }}>Retained imports and audit history are bounded. This application does not provide automatic expiry or a self-service erasure workflow. A deployment administrator must handle retention and erasure requests, including any retained backups.</p></section>
        <section><h2 style={{ fontSize: 16 }}>Questions and optional AI</h2><p>Private repository questions use source-backed extractive retrieval. They do not require an external generation model. Where an optional AI workflow is available, its approval explains the question and source passages sent to Voyage AI and DeepSeek before submission. Their handling of that data follows their own service terms.</p></section>
        <section><h2 style={{ fontSize: 16 }}>Publishing and independent providers</h2><p>A publication requires a reviewed snapshot, selected paths, content rights, and access policy. The selected source and signed metadata are delivered to the chosen provider operator. Provider requests disclose the approved question and required package/version identifiers. Review the disclosure before allowing private information to leave your workspace.</p><p style={{ marginTop: 10 }}>Independent providers handle delivered requests and source under their own policies. Revoking a publication stops new authorized access; it cannot erase material already delivered to a provider or buyer.</p></section>
        <section><h2 style={{ fontSize: 16 }}>Wallets and payment records</h2><p>Payments are limited to Tempo Moderato testnet, chain 42431. Your wallet approves signing; seed phrases and wallet private keys are not requested by the web application. Purchase records include approved terms, public addresses, payment status, and delivery references. A public blockchain can reveal transaction metadata. Private source and raw questions are not placed on-chain by Atlas.</p></section>
        <section><h2 style={{ fontSize: 16 }}>Browser storage and service providers</h2><p>Authentication uses Clerk’s browser session mechanisms. Your theme preference is saved locally in the browser. Hosting, database, authentication, GitHub, and any approved external providers also process the requests necessary to operate the service; their retention and privacy terms apply to their infrastructure.</p><p style={{ marginTop: 10 }}>Review <a href="https://clerk.com/legal/privacy" style={{ textDecoration: 'underline' }}>Clerk’s privacy notice</a> and <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" style={{ textDecoration: 'underline' }}>GitHub’s privacy statement</a> for their account services.</p></section>
      </div>
    </article>
    <footer className="landing-footer"><Link href="/">Chronos Atlas</Link><Link href="/terms">Terms</Link><Link href="/app/settings">Account settings</Link></footer>
  </main>;
}
