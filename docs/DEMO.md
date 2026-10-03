# Demonstration runbook (to implement)

Original source fixtures: `jobboard-app`, `retry-kit`, `event-log`. Retry-kit has 1.0.0 and 2.0.0 with a meaningful difference for permanent errors. They are local authored examples, not published npm packages or real customers.

1. Import jobboard-app as kind=fixture with content digest. Display the actual ts-morph graph.
2. Ask: How does this application retry failed jobs, and what could be affected by changing that behavior?
3. Inspect local source; show the two exact package dependencies.
4. Discover the two approved fixture providers and request approval of their context calls.
5. Obtain their evidence through actual separate endpoints. In testnet mode show real receipts; fixture mode says simulated/unimplemented explicitly.
6. Expand relevant source-backed subgraphs. Click a source locator; do not add decorative edges.
7. Change the dependency selection to retry-kit 2.0.0. Old evidence becomes inapplicable. Obtain matching evidence or refuse unsupported version. Reuse only compatible authorized evidence.
8. Show denied/outage/budget-unavailable cases without invented answers or automatic spending.

Final submission demo must use measured live testnet flow, not a static choreography. Do not fabricate explorer URLs, identities, independent customers or revenue. No source repository is executed by this product demonstration.
