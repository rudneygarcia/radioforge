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
  # Sem PUBLIC_HOST/PUBLIC_ORIGIN de propósito: os links de stream e de player seguem o endereço pelo qual a pessoa abriu o painel
  # (qualquer domínio ou o IP, como no AzuraCast). TLS_HOSTS só preenche a lista de domínios do certificado na primeira subida.
  cat > "$RF_DIR/.env" <<EOF
TZ=${RF_TZ}
TLS_HOSTS=${RF_DOMAIN}
TLS_EMAIL=${RF_EMAIL}
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
  fi

  fetch_code
  write_config
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

do_update() {
  need_root
  [ -d "$RF_DIR/.git" ] || die "não encontrei a instalação em $RF_DIR."
  fetch_code
  compose up -d --build
  docker image prune -f >/dev/null 2>&1 || true
  say "Atualizado."
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
  status)    compose ps ;;
  logs)      compose logs -f --tail=200 ;;
  restart)   compose restart ;;
  stop)      compose stop ;;
  start)     compose start ;;
  uninstall) do_uninstall ;;
  *) die "comando desconhecido: $CMD (use install, update, status, logs, restart, stop, start, uninstall)" ;;
esac
