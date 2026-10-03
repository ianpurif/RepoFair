---
name: atlas-verification
description: Validate implementation against actual source, test outcomes and independent security findings.
---

# atlas-verification

Read docs/TESTING.md. Create reviewed normal/adversarial fixtures. Check equal source access for comparisons. Record commands, exit codes and evidence. Unrun/skipped/unavailable is not passed. Do not lower assertions or substitute production mocks. Starter helper tests do not establish live integration. Use release gate only after underlying checks run.

Respect AGENTS.md and the task path lease. Keep results compact and evidence-backed.
