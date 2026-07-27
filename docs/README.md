# OpDesk documentation

Reference material for integrating with OpDesk and for operating it.

| Guide | What it covers |
|---|---|
| [api/overview.md](api/overview.md) | Base URL, JWT and API-key authentication, scopes, roles, request/response conventions, status codes, WebSocket, pagination, date formats. |
| [api/endpoints.md](api/endpoints.md) | Endpoint-by-endpoint reference for the incoming API, grouped by resource. |
| [api/webhooks.md](api/webhooks.md) | The **outgoing** CRM call-data push: field catalog, wire key names, duration formats, outcome values, renaming and remapping, delivery log. |
| [api/openapi.yaml](api/openapi.yaml) | OpenAPI 3.0 spec for the machine-reachable surface. Served live at `GET /api/openapi.yaml`. |

> **Tip:** FastAPI also generates interactive docs for every route the server exposes,
> at `/docs` (Swagger UI) and `/redoc`. Those are generated from the code and cover the
> whole surface including admin-only routes; the files above describe the *supported
> integration contract*, which is a deliberately smaller set.

For installation, configuration and operations, see the [project README](../README.md).
