#!/usr/bin/env bash
# RadioForge: instalador para servidores Linux SEM o Velix (Docker Compose). Funciona como o AzuraCast: o painel
# atende direto nas portas 80 (HTTP) e 443 (HTTPS), por qualquer domínio (ou IP) que aponte para o servidor, e o
# certificado Let's Encrypt (um ou vários domínios) é emitido DENTRO do painel, em Sistema -> HTTPS. Sem perguntas.
#
# Uso (como root, em Debian/Ubuntu/CentOS/Fedora com acesso à internet):
#   curl -fsSL https://raw.githubusercontent.com/rudneygarcia/radioforge/main/install.sh | sudo bash
#   # ou, já com o repositório baixado:  sudo ./install.sh
#
# Comandos:
#   install  (padrão)  instala Docker, baixa o projeto, sobe tudo
#   update             puxa o código novo e recria o contêiner (os dados em /data não são tocados)
#   update-run         (interno) usado pelo botão "Atualizar agora" do painel, via systemd
#   status | logs | restart | stop | start
#   uninstall          remove contêineres (pergunta antes de apagar os dados)
#
# Variáveis opcionais (para rodar sem perguntas):
#   RF_DOMAIN=a.com,b.com         domínio(s) já apontados para este servidor: o certificado é pedido sozinho ao subir
#                                 (opcional: dá para fazer depois, no painel, em Sistema -> HTTPS)
#   RF_EMAIL=voce@exemplo.com     e-mail dos avisos do Let's Encrypt (opcional)
#   RF_DIR=/opt/radioforge        pasta de instalação
#   RF_REPO=rudneygarcia/radioforge  RF_BRANCH=main
#   GITHUB_TOKEN=...              só se o repositório for privado (token de leitura)
#   RF_HTTP_PORT=80  RF_HTTPS_PORT=443   portas do painel no servidor (mude só se 80/443 já estiverem em uso)
#   RF_MEDIA_DIR=/mnt/hd/radioforge      guarda as MÚSICAS (pasta stations) neste disco (ex.: HD externo já montado), em vez do
#                                        volume do Docker no disco do sistema. O banco, os backups e o certificado ficam no disco do sistema.
#   RF_DISKS_DIR=/mnt                    pasta do servidor cujas SUBPASTAS são HDs já montados (ex.: /mnt/hd1, /mnt/hd2). No painel, cada estação
#                                        escolhe em qual deles guardar as músicas (ao criar e depois, movendo). Aparecem como /disks no contêiner.
#   RF_TZ=America/Sao_Paulo
set -euo pipefail

RF_DIR="${RF_DIR:-/opt/radioforge}"
RF_REPO="${RF_REPO:-rudneygarcia/radioforge}"
RF_BRANCH="${RF_BRANCH:-main}"
RF_HTTP_PORT="${RF_HTTP_PORT:-80}"
RF_HTTPS_PORT="${RF_HTTPS_PORT:-443}"
RF_TZ="${RF_TZ:-America/Sao_Paulo}"
RF_DOMAIN="${RF_DOMAIN:-}"
RF_EMAIL="${RF_EMAIL:-}"
RF_MEDIA_DIR="${RF_MEDIA_DIR:-}"
RF_DISKS_DIR="${RF_DISKS_DIR:-}"
CMD="${1:-install}"

c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_off=$'\033[0m'
say()  { echo "${c_ok}==>${c_off} $*"; }
warn() { echo "${c_warn}!!${c_off} $*" >&2; }
die()  { echo "${c_err}ERRO:${c_off} $*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "rode como root (sudo)."; }

# Pergunta com padrão; sem terminal (curl | bash) tenta /dev/tty, senão usa o padrão.
ask() { # ask "texto" "padrão" -> stdout
  local ans=""
  if [ -r /dev/tty ]; then read -r -p "$1 [$2]: " ans < /dev/tty || true; fi
  echo "${ans:-$2}"
}

compose() { (cd "$RF_DIR" && docker compose "$@"); }

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    say "Docker já instalado: $(docker --version)"
    return
  fi
  say "Instalando Docker (script oficial get.docker.com)..."
  command -v curl >/dev/null 2>&1 || {
    if command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y curl ca-certificates
    elif command -v dnf >/dev/null 2>&1; then dnf install -y curl ca-certificates
    elif command -v yum >/dev/null 2>&1; then yum install -y curl ca-certificates
    else die "instale o curl e rode de novo."; fi
  }
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "o plugin 'docker compose' não ficou disponível."
}

install_git() {
  command -v git >/dev/null 2>&1 && return
  say "Instalando git..."
  if command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then dnf install -y git
  elif command -v yum >/dev/null 2>&1; then yum install -y git
  else die "instale o git e rode de novo."; fi
}

fetch_code() {
  local url="https://github.com/${RF_REPO}.git"
  [ -n "${GITHUB_TOKEN:-}" ] && url="https://${GITHUB_TOKEN}@github.com/${RF_REPO}.git"
  if [ -d "$RF_DIR/.git" ]; then
    say "Atualizando código em $RF_DIR..."
    git -C "$RF_DIR" remote set-url origin "$url"
    git -C "$RF_DIR" fetch --depth 1 origin "$RF_BRANCH"
    git -C "$RF_DIR" reset --hard "origin/$RF_BRANCH"
    # não deixa o token gravado no .git/config
    git -C "$RF_DIR" remote set-url origin "https://github.com/${RF_REPO}.git"
  else
    say "Baixando $RF_REPO ($RF_BRANCH) em $RF_DIR..."
    mkdir -p "$(dirname "$RF_DIR")"
    git clone --depth 1 --branch "$RF_BRANCH" "$url" "$RF_DIR"
    git -C "$RF_DIR" remote set-url origin "https://github.com/${RF_REPO}.git"
  fi
}

# Gera .env e docker-compose.override.yml (arquivos locais, fora do git: ver .git/info/exclude).
write_config() {
  # Músicas em outro disco (ex.: HD externo): só a pasta "stations" vai para lá; banco, backups e certificado ficam no disco do sistema.
  local media_vol=""
  if [ -n "$RF_MEDIA_DIR" ]; then
    media_vol="    volumes:
      - \"${RF_MEDIA_DIR}/stations:/data/stations\""
  fi

  # Vários discos: a pasta com os HDs montados vai inteira para /disks (rslave: HD montado depois também aparece).
  local disks_vol="" disks_opt=""
  if [ -n "$RF_DISKS_DIR" ]; then
    # rslave (HD montado depois também aparece) só funciona se o ponto de montagem for compartilhado; senão o Docker nem sobe o contêiner.
    case "$(findmnt -no PROPAGATION -T "$RF_DISKS_DIR" 2>/dev/null)" in shared|slave) disks_opt=":rslave";; esac
    if [ -n "$media_vol" ]; then
      disks_vol="      - \"${RF_DISKS_DIR}:/disks${disks_opt}\""
    else
      disks_vol="    volumes:
      - \"${RF_DISKS_DIR}:/disks${disks_opt}\""
    fi
  fi

  # Sem PUBLIC_HOST/PUBLIC_ORIGIN de propósito: os links de stream e de player seguem o endereço pelo qual a pessoa abriu o painel
  # (qualquer domínio ou o IP, como no AzuraCast). TLS_HOSTS só preenche a lista de domínios do certificado na primeira subida.
  cat > "$RF_DIR/.env" <<EOF
TZ=${RF_TZ}
TLS_HOSTS=${RF_DOMAIN}
TLS_EMAIL=${RF_EMAIL}
RF_MEDIA_DIR=${RF_MEDIA_DIR}
RF_DISKS_DIR=${RF_DISKS_DIR}
EOF
  chmod 600 "$RF_DIR/.env"

  # O painel atende direto nas portas 80 (HTTP) e 443 (HTTPS): a 80 também recebe o desafio do Let's Encrypt
  # (/.well-known/acme-challenge/), e o certificado emitido em Sistema -> HTTPS vale para o painel e para as portas das rádios.
  cat > "$RF_DIR/docker-compose.override.yml" <<EOF
services:
  radioforge:
    environment:
      PUBLIC_HOST: ""
      PUBLIC_ORIGIN: ""
      TZ: \${TZ:-America/Sao_Paulo}
      TLS_HOSTS: \${TLS_HOSTS:-}
      TLS_EMAIL: \${TLS_EMAIL:-}
    ports: !override
      - "${RF_HTTP_PORT}:3000"
      - "${RF_HTTPS_PORT}:3443"
      - "8000-8499:8000-8499"
      - "2222:2222"
${media_vol}
${disks_vol}
EOF
  rm -f "$RF_DIR/Caddyfile"

  local excl="$RF_DIR/.git/info/exclude"
  for f in .env docker-compose.override.yml Caddyfile; do
    grep -qxF "$f" "$excl" 2>/dev/null || echo "$f" >> "$excl"
  done
}

open_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    say "Liberando portas no ufw..."
    ufw allow 8000:8499/tcp >/dev/null
    ufw allow 2222/tcp >/dev/null
    ufw allow "${RF_HTTP_PORT}/tcp" >/dev/null
    ufw allow "${RF_HTTPS_PORT}/tcp" >/dev/null
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    say "Liberando portas no firewalld..."
    firewall-cmd --permanent --add-port=8000-8499/tcp --add-port=2222/tcp >/dev/null
    firewall-cmd --permanent --add-port="${RF_HTTP_PORT}/tcp" --add-port="${RF_HTTPS_PORT}/tcp" >/dev/null
    firewall-cmd --reload >/dev/null
  else
    warn "Nenhum firewall ativo detectado. Se o provedor tiver firewall externo, libere: ${RF_HTTP_PORT}, ${RF_HTTPS_PORT}, 8000-8499 e 2222 (TCP)."
  fi
}

# Prepara a pasta das músicas no disco escolhido (RF_MEDIA_DIR): cria, dá acesso ao usuário do contêiner (uid 1001) e avisa dos riscos.
prepare_media_dir() {
  [ -n "$RF_MEDIA_DIR" ] || return 0
  case "$RF_MEDIA_DIR" in /*) ;; *) die "RF_MEDIA_DIR precisa ser um caminho completo (ex.: /mnt/hd/radioforge).";; esac
  mkdir -p "$RF_MEDIA_DIR/stations"
  chown -R 1001:1001 "$RF_MEDIA_DIR/stations"
  # Se a pasta está no mesmo disco da raiz, o HD provavelmente não está montado: as músicas iriam para o disco do sistema do mesmo jeito.
  if [ "$(stat -c %d "$RF_MEDIA_DIR" 2>/dev/null)" = "$(stat -c %d / 2>/dev/null)" ]; then
    warn "$RF_MEDIA_DIR está no MESMO disco do sistema. O HD externo está montado? (confira com 'df -h $RF_MEDIA_DIR')"
  fi
  # Já havia músicas no volume do Docker e a pasta nova está vazia: elas não aparecem até serem copiadas.
  if docker volume inspect radioforge_radioforge-data >/dev/null 2>&1 && [ -z "$(ls -A "$RF_MEDIA_DIR/stations" 2>/dev/null)" ]; then
    warn "Há dados no volume do Docker e a pasta nova está vazia. Para levar as músicas que já existem, rode ANTES de usar: radioforge stop &&"
    warn "  docker run --rm -v radioforge_radioforge-data:/from -v ${RF_MEDIA_DIR}:/to alpine sh -c 'cp -a /from/stations/. /to/stations/ && chown -R 1001:1001 /to/stations'"
  fi
}

# Prepara os discos extras (subpastas de RF_DISKS_DIR): cria "stations" em cada um e dá acesso ao usuário do contêiner (uid 1001).
prepare_disks_dir() {
  [ -n "$RF_DISKS_DIR" ] || return 0
  case "$RF_DISKS_DIR" in /*) ;; *) die "RF_DISKS_DIR precisa ser um caminho completo (ex.: /mnt).";; esac
  [ -d "$RF_DISKS_DIR" ] || die "$RF_DISKS_DIR não existe."
  local d n=0
  for d in "$RF_DISKS_DIR"/*/; do
    [ -d "$d" ] || continue
    mkdir -p "${d}stations" && chown 1001:1001 "${d}stations" "${d%/}" 2>/dev/null || warn "Não consegui preparar $d (somente leitura?)"
    n=$((n+1))
  done
  [ "$n" -gt 0 ] || warn "Nenhuma subpasta em $RF_DISKS_DIR: monte os HDs em pastas dentro dela (ex.: $RF_DISKS_DIR/hd1)."
}

install_cli() {
  cat > /usr/local/bin/radioforge <<EOF
#!/usr/bin/env bash
exec "$RF_DIR/install.sh" "\$@"
EOF
  chmod +x /usr/local/bin/radioforge
}

do_install() {
  need_root
  install_docker
  install_git

  # Reinstalar/atualizar mantém o que já estava (domínios e e-mail do .env; instalações antigas guardavam o domínio em PUBLIC_ORIGIN).
  if [ -f "$RF_DIR/.env" ]; then
    [ -n "$RF_DOMAIN" ] || RF_DOMAIN="$(grep '^TLS_HOSTS=' "$RF_DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
    [ -n "$RF_DOMAIN" ] || RF_DOMAIN="$(grep '^PUBLIC_ORIGIN=https://' "$RF_DIR/.env" 2>/dev/null | sed 's#PUBLIC_ORIGIN=https://##' || true)"
    [ -n "$RF_EMAIL" ] || RF_EMAIL="$(grep '^TLS_EMAIL=' "$RF_DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
    [ -n "$RF_MEDIA_DIR" ] || RF_MEDIA_DIR="$(grep '^RF_MEDIA_DIR=' "$RF_DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
    [ -n "$RF_DISKS_DIR" ] || RF_DISKS_DIR="$(grep '^RF_DISKS_DIR=' "$RF_DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
  fi

  fetch_code
  prepare_media_dir
  prepare_disks_dir
  write_config
  setup_updater
  open_firewall
  install_cli

  say "Construindo e subindo (o primeiro build leva alguns minutos)..."
  compose up -d --build --remove-orphans

  local ip port=""
  ip="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  [ "$RF_HTTP_PORT" = "80" ] || port=":${RF_HTTP_PORT}"
  echo
  say "Pronto! Painel: http://${ip}${port}"
  echo "   Primeiro acesso: crie o administrador na tela inicial."
  echo "   HTTPS (como no AzuraCast): aponte o DNS (registro A) dos seus domínios para este servidor e, no painel,"
  echo "   em Sistema -> HTTPS, informe os domínios e clique em 'Salvar e emitir certificado'. Vale para o painel (porta ${RF_HTTPS_PORT})"
  echo "   e para as portas das rádios. Qualquer domínio que aponte para o IP abre o painel."
  [ -n "$RF_DOMAIN" ] && echo "   Domínio(s) já informado(s): ${RF_DOMAIN} (o certificado é pedido sozinho assim que o DNS responder)."
  echo "   Dados (músicas, banco, configurações): volume Docker 'radioforge_radioforge-data'."
  echo "   Comandos: radioforge update | status | logs | restart | stop | start | uninstall"
}

# Atualização pelo painel (Sistema -> Atualizar agora): o painel roda no contêiner e não consegue se recriar sozinho. Ele deixa um
# pedido na pasta update-queue (montada em /update) e este serviço do systemd, no servidor, roda "radioforge update-run".
setup_updater() {
  local q="$RF_DIR/update-queue"
  mkdir -p "$q"
  chown 1001:1001 "$q" 2>/dev/null || true
  cat > "$RF_DIR/docker-compose.update.yml" <<YML
services:
  radioforge:
    environment:
      UPDATE_DIR: /update
    volumes:
      - "${q}:/update"
YML
  local list="docker-compose.yml"
  [ -f "$RF_DIR/docker-compose.override.yml" ] && list="$list:docker-compose.override.yml"
  list="$list:docker-compose.update.yml"
  if grep -q '^COMPOSE_FILE=' "$RF_DIR/.env" 2>/dev/null; then
    sed -i "s#^COMPOSE_FILE=.*#COMPOSE_FILE=${list}#" "$RF_DIR/.env"
  else
    echo "COMPOSE_FILE=${list}" >> "$RF_DIR/.env"
  fi
  chmod 600 "$RF_DIR/.env"
  local excl="$RF_DIR/.git/info/exclude" f
  for f in docker-compose.update.yml update-queue/; do
    grep -qxF "$f" "$excl" 2>/dev/null || echo "$f" >> "$excl"
  done

  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    warn "systemd não encontrado: o botão 'Atualizar agora' do painel não vai funcionar. Atualize com: radioforge update"
    return 0
  fi
  cat > /etc/systemd/system/radioforge-update.service <<UNIT
[Unit]
Description=RadioForge: atualização pedida pelo painel

[Service]
Type=oneshot
Environment="RF_DIR=${RF_DIR}"
Environment="RF_REPO=${RF_REPO}"
Environment="RF_BRANCH=${RF_BRANCH}"
ExecStart=${RF_DIR}/install.sh update-run
TimeoutStartSec=3600
UNIT
  cat > /etc/systemd/system/radioforge-update.path <<UNIT
[Unit]
Description=RadioForge: vigia o pedido de atualização do painel

[Path]
PathExists=${q}/request

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now radioforge-update.path >/dev/null 2>&1 || warn "Não consegui ligar o radioforge-update.path (o botão 'Atualizar agora' pode não funcionar)."
}

do_update() {
  need_root
  [ -d "$RF_DIR/.git" ] || die "não encontrei a instalação em $RF_DIR."
  fetch_code
  # Roda o instalador NOVO (o arquivo acabou de ser trocado pelo git).
  exec "$RF_DIR/install.sh" _apply
}

do_apply() {
  need_root
  setup_updater
  compose up -d --build
  docker image prune -f >/dev/null 2>&1 || true
  say "Atualizado."
}

# Chamado pelo systemd quando o painel pede a atualização: grava o andamento em update-queue/status (lido pelo painel).
do_update_run() {
  need_root
  local q="$RF_DIR/update-queue" rc=0
  mkdir -p "$q"
  rm -f "$q/request"
  echo "running $(date +%s)" > "$q/status"
  "$RF_DIR/install.sh" update > "$q/log" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then echo "done $(date +%s)" > "$q/status"; else echo "error $(date +%s)" > "$q/status"; fi
  # o painel (uid 1001) precisa conseguir regravar o status no próximo pedido
  chown 1001:1001 "$q/status" "$q/log" 2>/dev/null || true
  chmod 644 "$q/status" "$q/log"
}

do_uninstall() {
  need_root
  [ -d "$RF_DIR" ] || die "não encontrei a instalação em $RF_DIR."
  warn "Isso para e remove os contêineres."
  local wipe
  wipe="$(ask 'Apagar TAMBÉM os dados (músicas, banco, configurações)? Irreversível. Digite APAGAR para confirmar' 'não')"
  if [ "$wipe" = "APAGAR" ]; then compose down -v; else compose down; fi
  rm -f /usr/local/bin/radioforge
  say "Removido. Arquivos do projeto continuam em $RF_DIR (apague manualmente se quiser)."
}

case "$CMD" in
  install)   do_install ;;
  update)    do_update ;;
  _apply)    do_apply ;;
  update-run) do_update_run ;;
  status)    compose ps ;;
  logs)      compose logs -f --tail=200 ;;
  restart)   compose restart ;;
  stop)      compose stop ;;
  start)     compose start ;;
  uninstall) do_uninstall ;;
  *) die "comando desconhecido: $CMD (use install, update, status, logs, restart, stop, start, uninstall)" ;;
esac
