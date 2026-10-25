# OpDesk documentation

Reference material for operating OpDesk and for integrating with it.

## Guides

| Guide | What it covers |
|---|---|
| [guides/installation.md](guides/installation.md) | Supported systems (Issabel 5, FreePBX 16/17), ports and the Apache conflict, what the installer does per OS, native and Docker installs, running, updating (including from the Python backend), troubleshooting. |
| [guides/configuration.md](guides/configuration.md) | `backend/.env`, every Settings sub-tab, roles, visibility and groups, audit log, debugging. |
| [guides/analytics.md](guides/analytics.md) | Every KPI, how it is computed, and how to tune it. |
| [guides/mobile-push.md](guides/mobile-push.md) | Mobile softphone: QR sign-in, RFC 8599 wake-up, Firebase and APNs setup, Web Push, troubleshooting. |

## API

| Reference | What it covers |
|---|---|
| [api/overview.md](api/overview.md) | Base URL, JWT and API-key authentication, scopes, roles, request/response conventions, status codes, WebSocket, pagination, date formats. |
| [api/endpoints.md](api/endpoints.md) | Endpoint-by-endpoint reference for the incoming API, grouped by resource. |
| [api/webhooks.md](api/webhooks.md) | The **outgoing** CRM call-data push: field catalog, wire key names, duration formats, outcome values, renaming and remapping, delivery log. |
| [api/contact-lookup.md](api/contact-lookup.md) | The contacts phonebook and the **incoming** CRM contact lookup: `[Number]` URL template, name template, number formats, match verification, manual vs CRM-sourced contacts, softphone/dashboard display. |
| [api/openapi.yaml](api/openapi.yaml) | OpenAPI 3.0 spec for the machine-reachable surface. Served live at `GET /api/openapi.yaml`. |

> **Tip:** a running server also serves interactive docs for every route it exposes, at
> `/docs` (Swagger UI), `/redoc` and `/openapi.json`. They cover the whole surface, including
> admin-only routes. The files above describe the *supported integration contract*, which
> is a deliberately smaller set.

For an overview of OpDesk, see the [project README](../README.md).
