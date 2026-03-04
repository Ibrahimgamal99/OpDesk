
# Stage 1: Build frontend (Vite)
FROM node:22-bookworm-slim AS frontend_builder
WORKDIR /opt/opdesk/frontend

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install

COPY frontend/ ./
RUN npm run build


# Stage 2: Runtime (Python / FastAPI)
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Minimal OS tools (curl used for basic checks; openssl sometimes handy)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/opdesk

# Install backend deps
COPY backend/requirements.txt /opt/opdesk/backend/requirements.txt
RUN pip install --no-cache-dir -r /opt/opdesk/backend/requirements.txt

# Copy backend
COPY backend/ /opt/opdesk/backend/

# Copy built frontend into the location server.py expects: ../frontend/dist
COPY --from=frontend_builder /opt/opdesk/frontend/dist /opt/opdesk/frontend/dist

# Optional: include start.sh (not required, but useful)
COPY start.sh /opt/opdesk/start.sh
RUN chmod +x /opt/opdesk/start.sh

EXPOSE 8443

# No /api/health in repo, so check "/"
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -kfsS https://localhost:8443/ >/dev/null || exit 1

# Run the server exactly as the repo does
WORKDIR /opt/opdesk/backend
CMD ["python", "server.py"]
