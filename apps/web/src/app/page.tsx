import { starterCapabilities } from '@atlas/core';
export default function Home() {
  const status = starterCapabilities();
  return <main id="main">
    <header><span className="wordmark">Chronos Atlas</span><span className="badge">Development starter</span></header>
    <h1>Map your code.<br />Connect the knowledge.</h1>
    <p>The build starts here. This source scaffold is not the completed graph workspace or a live provider marketplace.</p>
    <div className="grid">
      <section className="panel"><h2>One instruction to begin</h2><p>Open this folder in Codex and send:</p><pre><code>Read and execute START.md.</code></pre><p>Astra medium coordinates; Sol extra-high agents implement and verify. Actual access is checked in your Codex session.</p><a href="/demo">Inspect the fixture plan</a></section>
      <section className="panel"><h2>Actual capability status</h2><dl>{Object.entries(status.capabilities).map(([name,state])=><div key={name}><dt>{name}</dt><dd>{state.replaceAll('-', ' ')}</dd></div>)}</dl></section>
    </div>
    <footer>No live payments, repository import, generated answers or simulated customer metrics are enabled. <a href="/api/capabilities">Machine-readable status</a></footer>
  </main>;
}
