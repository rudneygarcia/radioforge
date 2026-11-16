# --- Etapa 1: compila API e painel ---
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install
COPY . .
RUN npm run build && node scripts/build-info.mjs

# --- Etapa 2: imagem final com Icecast + Liquidsoap + Node ---
# NOTA: a imagem oficial do Liquidsoap traz a versão 2.x exigida pelos scripts gerados
# (radio.on_metadata, thread.run). Ajuste a tag conforme a versão estável mais recente.
FROM savonet/liquidsoap:v2.3.3
USER root
ENV DEBIAN_FRONTEND=noninteractive
# NÃO instalar o pacote "ffmpeg" aqui: ele troca as bibliotecas libav* da imagem do Liquidsoap por
# outra versão e o Liquidsoap morre ao iniciar ("Could not find OCaml value ... recompile the ffmpeg binding").
RUN apt-get update \
 && apt-get install -y --no-install-recommends icecast2 ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
# Voz da "hora certa" (espeak-ng, português do Brasil). Instalação à parte e protegida: se falhar, ou se quebrar o
# Liquidsoap (teste abaixo), o espeak-ng é removido e a imagem continua sem a voz, em vez de derrubar o build/rádio.
RUN (apt-get update && apt-get install -y --no-install-recommends espeak-ng \
      && (liquidsoap --list-functions > /dev/null 2>&1 || (echo "espeak-ng quebrou o Liquidsoap: removendo" && apt-get purge -y espeak-ng))) \
    || echo "espeak-ng não instalado: hora certa indisponível"; \
    rm -rf /var/lib/apt/lists/*
# master_me (processador de volume/loudness usado no AzuraCast, https://github.com/trummerschlunk/master_me):
# baixa o .so LADSPA já compilado e coloca em /usr/lib/ladspa (mesma pasta dos plugins da LSP). Instalação à parte
# e protegida, como o espeak-ng: se não puder baixar ou quebrar o Liquidsoap (teste abaixo), é removido e a imagem
# continua sem ele (o processador interno continua disponível).
RUN set -e; \
    (apt-get update && apt-get install -y --no-install-recommends curl xz-utils \
      && curl -fsSL -o /tmp/master_me.tar.xz "https://github.com/trummerschlunk/master_me/releases/download/1.3.1/master_me-1.3.1-linux-x86_64.tar.xz" \
      && mkdir -p /usr/lib/ladspa \
      && tar -xJf /tmp/master_me.tar.xz -C /tmp master_me-1.3.1/master_me-ladspa.so \
      && mv /tmp/master_me-1.3.1/master_me-ladspa.so /usr/lib/ladspa/ \
      && (liquidsoap --list-functions > /dev/null 2>&1 || (echo "master_me quebrou o Liquidsoap: removendo" && rm -f /usr/lib/ladspa/master_me-ladspa.so)) \
      && apt-get purge -y curl xz-utils) \
    || echo "master_me não instalado"; \
    rm -rf /tmp/master_me* /var/lib/apt/lists/*
# Só informa no log do build se o Liquidsoap enxergou o master_me (não falha o build).
RUN echo "== master_me"; (liquidsoap --list-functions 2>&1 | grep -i master_me) || echo "(não encontrado)"
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
# Mostra no log do build a versão de cada programa (não falha o build: só informa).
RUN for c in "node --version" "liquidsoap --version" "icecast2 -v" "liquidsoap --list-functions"; do echo "== $c"; $c 2>&1 | head -2 || true; done

RUN useradd --create-home --uid 1001 radio \
 && mkdir -p /data /app && chown -R radio:radio /data /app
WORKDIR /app
COPY --from=build --chown=radio:radio /src/package.json ./package.json
COPY --from=build --chown=radio:radio /src/node_modules ./node_modules
COPY --from=build --chown=radio:radio /src/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=radio:radio /src/apps/api/dist ./apps/api/dist
COPY --from=build --chown=radio:radio /src/apps/web/dist ./apps/web/dist
COPY --from=build --chown=radio:radio /src/BUILD_INFO.json ./BUILD_INFO.json

USER radio
# Fuso dos logs do servidor (troque pela variável TZ no Velix, se precisar).
ENV TZ=America/Sao_Paulo
ENV NODE_ENV=production DATA_DIR=/data WEB_DIR=/app/apps/web/dist PORT=3000
EXPOSE 3000 3443 2222 8000-8499
VOLUME /data
ENTRYPOINT []
CMD ["node", "apps/api/dist/index.js"]
