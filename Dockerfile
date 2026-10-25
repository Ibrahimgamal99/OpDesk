# OpDesk container image: NestJS backend (Node 24) serving the built React frontend.
# Uses host networking (see docker-compose.yml): MariaDB and Asterisk AMI are reached on 127.0.0.1,
# and nginx on the host terminates TLS in front of 127.0.0.1:8765.

# --- Stage 1: frontend (Vite) --------------------------------------------------------------------
FROM node:24-bookworm-slim AS frontend
WORKDIR /opt/opdesk/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- Stage 2: backend (tsc), then production-only node_modules -----------------------------------
FROM node:24-bookworm-slim AS backend
WORKDIR /opt/opdesk/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# --- Stage 3: runtime ----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    VAD_PYTHON=/opt/opdesk/backend/vad/.venv/bin/python

# Python only for the voice-activity analysis (backend/vad), in its own venv.
# webrtcvad-wheels ships prebuilt wheels, so no compiler is needed.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY backend/vad/requirements.txt /tmp/vad-requirements.txt
RUN python3 -m venv /opt/opdesk/backend/vad/.venv \
  && /opt/opdesk/backend/vad/.venv/bin/pip install --no-cache-dir -r /tmp/vad-requirements.txt \
  && rm -f /tmp/vad-requirements.txt

WORKDIR /opt/opdesk
COPY --from=backend /opt/opdesk/backend/dist backend/dist
COPY --from=backend /opt/opdesk/backend/node_modules backend/node_modules
COPY backend/package.json backend/schema.sql backend/
COPY backend/vad/ backend/vad/
COPY --from=frontend /opt/opdesk/frontend/dist frontend/dist
# GET /api/openapi.yaml serves docs/api/openapi.yaml, so the docs ship in the image.
COPY docs/ docs/

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.OPDESK_LISTEN_PORT || process.env.PORT || 8765) + '/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

WORKDIR /opt/opdesk/backend
CMD ["node", "dist/main.js"]
