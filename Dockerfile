FROM node:22-slim AS builder

ARG MOZI_BUILD_COMMIT=unknown
ARG MOZI_BUILD_TIME
ARG MOZI_RELEASE_CHANNEL=stable
ARG MOZI_EXTRA_CA_CERT_B64=
ENV MOZI_BUILD_COMMIT=${MOZI_BUILD_COMMIT}
ENV MOZI_BUILD_TIME=${MOZI_BUILD_TIME}
ENV MOZI_RELEASE_CHANNEL=${MOZI_RELEASE_CHANNEL}

WORKDIR /app

# Debian's slim Node image does not include a system trust store. Install one
# before the first Node network request, and optionally add a PEM root
# certificate supplied as base64 by the image builder.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && if [ -n "$MOZI_EXTRA_CA_CERT_B64" ]; then \
    printf '%s' "$MOZI_EXTRA_CA_CERT_B64" | base64 --decode > /usr/local/share/ca-certificates/mozi-extra-ca.crt; \
    update-ca-certificates; \
  fi \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.29.2 --activate

# Copy entire workspace before install — pnpm needs pnpm-workspace.yaml +
# ui/package.json visible to resolve the `mozi-ui` workspace package.
COPY . .

RUN pnpm install --frozen-lockfile --prod=false

# Build server (tsup -> dist/) and Web UI (vite -> ui/dist/)
RUN pnpm build && pnpm --filter mozi-ui build

# ---
FROM node:22-slim AS runtime

ARG MOZI_BUILD_COMMIT=unknown
ARG MOZI_BUILD_TIME=unknown
ARG MOZI_BUILD_VERSION=unknown
ARG MOZI_RELEASE_CHANNEL=stable
ARG MOZI_EXTRA_CA_CERT_B64=
LABEL org.opencontainers.image.version=${MOZI_BUILD_VERSION} \
      org.opencontainers.image.revision=${MOZI_BUILD_COMMIT} \
      org.opencontainers.image.created=${MOZI_BUILD_TIME} \
      ai.mozi.release.channel=${MOZI_RELEASE_CHANNEL}

WORKDIR /app

COPY requirements/document-runtime.txt ./requirements/document-runtime.txt
COPY requirements/document-runtime-constraints.txt ./requirements/document-runtime-constraints.txt

# Bundled document/media skills (docx, pdf, pptx, xlsx, slack-gif-creator)
# declare python3 in requires.bins and pip packages in their install specs.
# Install them at build time so the skills are Ready offline instead of
# surfacing "Needs setup" in the enterprise container.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip git poppler-utils \
    libreoffice-impress libreoffice-writer libreoffice-calc libreoffice-core fonts-noto-cjk \
  && if [ -n "$MOZI_EXTRA_CA_CERT_B64" ]; then \
    printf '%s' "$MOZI_EXTRA_CA_CERT_B64" | base64 --decode > /usr/local/share/ca-certificates/mozi-extra-ca.crt; \
    update-ca-certificates; \
  fi \
  && rm -rf /var/lib/apt/lists/*

# Keep Python packages in their own layer so a registry failure does not force
# Docker to repeat the much larger LibreOffice installation.
RUN pip3 install --no-cache-dir --break-system-packages \
    --requirement requirements/document-runtime.txt \
    --constraint requirements/document-runtime-constraints.txt \
  && python3 -c 'import defusedxml, docx, imageio, numpy, openpyxl, pandas, pdf2image, pdfplumber, PIL, pptx, pypdf, reportlab, markitdown'

RUN corepack enable && corepack prepare pnpm@10.29.2 --activate

# Root manifest + lockfile only: pnpm resolves the root importer without the
# workspace file, and pulling ui/ in here would install the UI's production
# tree (~900 MB) that this stage never uses — it copies the built ui/dist from
# the builder. desktop/ is unavailable anyway (.dockerignore).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/src/templates ./src/templates
COPY --from=builder /app/ui/dist ./ui/dist

# Single source of truth for runtime data: $MOZI_HOME (mount this as a volume).
# Persisted contents: mozi.json, .env, jwt-secret, .master-key, data/mozi.db
ENV MOZI_HOME=/data
ENV NODE_ENV=production

# Container must bind 0.0.0.0 to be reachable from outside the container.
ENV MOZI_SERVER_HOST=0.0.0.0
ENV MOZI_SERVER_PORT=9210
ENV MOZI_BUILD_SURFACE=docker
ENV MOZI_PYTHON=/usr/bin/python3
ENV PYTHONNOUSERSITE=1

RUN mkdir -p /data

EXPOSE 9210

CMD ["node", "dist/index.js"]
