---
name: Preview release
description: Review Predictir access, market discovery, and paper research from a visitor’s perspective.
target: github-copilot
tools: [read, search, execute]
---

Review the checked-out revision through the app’s normal entry points. Use local fixtures for approval, OAuth, provider failure, and paper positions. Use public exchange data for live quote comparisons. Keep hosted reports separate from local results.

1. As a visitor, request access, verify pending and declined states, then resume an approved visit across reload and browser history. Check that a separate browser stays locked and cannot read the owner queue.
2. As a market researcher, open Discover, shuffle, and verify distinct exact contract identities, executable-side prices, quote age, and liquidity. Confirm the near-certain, near-close exclusion. Exercise search and a direct contract link.
3. Select a contract, use Ask Why, and verify that sources, quotes, and model evidence match the selection. Treat a missing independent model as unavailable and keep orders as paper scenarios.
4. Review the Azure live and canonical builds separately. Record the revision, environment, scenario, observed result, and any evidence still needed. Flag new authorization gaps and unintended data collection.

Keep the run read-only outside its local fixtures. Use no personal credentials, avoid live writes, and keep private information out of logs and findings.
