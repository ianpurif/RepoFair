# Product design direction

A quiet developer workspace: neutral background, single restrained accent, system typography, readable code, moderate density and consistent 8px rhythm. Light/dark themes; no download-time remote fonts. Avoid crypto exchange styling, vanity metrics and fabricated activity.

Desktop: resizable repository explorer (roughly 240px), flexible graph, source/evidence inspector (roughly 360px). Compact header has repository + exact version, search, actual job status and account menu. Composer remains near the graph without obscuring navigation. Mobile collapses panels with explicit navigation and list alternatives.

Graph begins at module/folder level. Only selected neighborhoods expand. Preserve positions when providers attach. Distinguish local source, external provider, unresolved reference and stale/inapplicable evidence by labels as well as color. Every node/edge shown must have real origin information.

Use source inspector for line links and provider provenance. Purchase approval displays price asset/network, recipient/provider, fixed operation, version, remaining allowance and private fields about to leave the app. Do not hide cost behind a generic Continue button.

Publishing is short: repository rights -> version/exposure preview -> price/recipient -> confirmation. Read access is not publishing permission. No pre-checked public exposure for private repositories.

Jobs: queued, running, partial, complete, cancelled, failed. Sonner handles small events; long jobs show persistent progress. Show empty, unavailable and denied states without leaking private record existence.

Accessibility: keyboard selection, focus management, visible focus, contrast, reduced motion, helpful labels, resizable controls with non-pointer alternatives. Verify at desktop and narrow viewport sizes.

The delivered landing/status screen is only a starter. Replace it with the working workspace during P1/P5; do not invest in a giant marketing site first.
