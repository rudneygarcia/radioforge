# --- Etapa 1: compila API e painel ---
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install
COPY . .
RUN npm run build

# --- Etapa 2: imagem final com Icecast + Liquidsoap + Node ---
# NOTA: a imagem oficial do Liquidsoap traz a versão 2.x exigida pelos scripts gerados
# (radio.on_metadata, thread.run). Ajuste a tag conforme a versão estável mais recente.
FROM savonet/liquidsoap:v2.3.3
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends icecast2 ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node

RUN useradd --create-home --uid 1001 radio \
 && mkdir -p /data /app && chown -R radio:radio /data /app
WORKDIR /app
COPY --from=build --chown=radio:radio /src/package.json ./package.json
COPY --from=build --chown=radio:radio /src/node_modules ./node_modules
COPY --from=build --chown=radio:radio /src/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=radio:radio /src/apps/api/dist ./apps/api/dist
COPY --from=build --chown=radio:radio /src/apps/web/dist ./apps/web/dist

USER radio
ENV NODE_ENV=production DATA_DIR=/data WEB_DIR=/app/apps/web/dist PORT=3000
EXPOSE 3000 8000-8499
VOLUME /data
ENTRYPOINT []
CMD ["node", "apps/api/dist/index.js"]
