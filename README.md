# RadioForge

Plataforma de gestão de web rádio para servidores Linux, no mesmo espírito do AzuraCast, mas com código próprio (nome de trabalho, fácil de trocar).

**Stack:** Node.js + TypeScript (Fastify, SQLite) · React (Vite) · Icecast 2 · Liquidsoap 2 · Docker Compose.

> O AzuraCast é AGPL-3.0. Este projeto **não copia código dele**; usa só como referência de funcionalidades. Icecast e Liquidsoap rodam como programas externos.

## Como funciona

```
Painel React ──► API Fastify ──► gera configs ──► Icecast (1 por estação)
                    ▲                              ▲
                    │ webhook de faixa             │ áudio
                    └────────── Liquidsoap (1 por estação) ◄── DJ ao vivo (porta +5)
```

Cada estação tem 10 portas: `+0` Icecast (ouvintes), `+5` entrada do DJ, `+6` telnet local do Liquidsoap (pedidos). Prioridade de fontes: **DJ ao vivo > pedidos > rotação das playlists > silêncio**.

## Rodando

Produção (servidor Linux com Docker):

```bash
PUBLIC_HOST=radio.seudominio.com docker compose up -d --build
```

Abra `http://SERVIDOR:3000`. Na primeira visita o painel pede para criar o administrador. Libere as portas `3000` e `8000-8499` no firewall (ideal: colocar um proxy reverso com HTTPS na frente do `3000`).

**Instalador para servidores sem o Velix** (Debian/Ubuntu/CentOS/Fedora, como root), no estilo do AzuraCast: instala o Docker, baixa o projeto em `/opt/radioforge`, gera `.env`, libera as portas no firewall e sobe tudo, **sem perguntas**. O painel atende direto nas portas **80** (HTTP) e **443** (HTTPS), por qualquer domínio ou pelo IP; as portas das rádios são 8000–8499 e o SFTP é 2222. Para o HTTPS, aponte o DNS dos seus domínios (um ou vários) para o servidor e, no painel, em **Sistema → HTTPS**, informe os domínios e clique em *Salvar e emitir certificado*: um certificado só vale para o painel (443) e para as portas das rádios, e renova sozinho.

```bash
curl -fsSL https://raw.githubusercontent.com/rudneygarcia/radioforge/main/install.sh | sudo bash
# opcional, sem abrir o painel:  RF_DOMAIN=a.com,b.com  RF_EMAIL=voce@exemplo.com  (o certificado é pedido ao subir)
```

Depois use `radioforge update | status | logs | restart | stop | start | uninstall`. Variáveis: `RF_DOMAIN`, `RF_EMAIL`, `RF_DIR`, `RF_REPO`, `RF_BRANCH`, `GITHUB_TOKEN` (repositório privado), `RF_HTTP_PORT` e `RF_HTTPS_PORT` (padrão 80 e 443; mude só se já estiverem em uso), `RF_TZ`. Quem instalou antes com o Caddy: rode o comando de instalação de novo (os dados são mantidos) para passar ao modelo novo. Requer Docker (o script instala).

Desenvolvimento (Windows/Linux, sem streaming):

```bash
npm install
ENGINE_ENABLED=false npm run dev:api   # API em :3000
npm run dev:web                        # painel em :5173 (proxy para a API)
```

Variáveis: `PUBLIC_HOST`, `PORT`, `DATA_DIR`, `ENGINE_ENABLED`, `JWT_SECRET`, `INTERNAL_TOKEN` (os dois segredos são gerados e salvos em `DATA_DIR/.secrets` se não informados).

## Motores de streaming

A API escolhe sozinha (`ENGINE_MODE=auto`, padrão):

| Modo | Quando | O que oferece |
|---|---|---|
| `liquidsoap` | Icecast e Liquidsoap instalados (imagem Docker) | Tudo: DJ ao vivo, crossfade, normalização, vários formatos/bitrates |
| `native` | Sem esses programas (ex.: Windows, para testar) | Motor simples em Node: **só MP3**, playlists e agendamento, pedidos, relatórios. Sem DJ, crossfade, normalização, gravação ou transcodificação (streams extras repetem o principal). Sem playlists, toca a biblioteca inteira |

Force um modo com `ENGINE_MODE=native` ou `ENGINE_MODE=liquidsoap`. O painel avisa quando está no modo simples. O endereço do stream é `http://<host>:<porta>/radio.mp3` (nome padrão de estações novas; editável em Configurações → Nome do stream, ou `/radio.ogg` se o formato for OGG; estações antigas continuam em `/radio` até serem editadas); no Windows, libere o Node no firewall se ele perguntar.

## Estado atual

| Área | Situação |
|---|---|
| Login, primeiro setup, papéis admin/operador | Pronto, testado localmente |
| Biblioteca com **pastas** (criar/renomear/excluir, enviar direto para a pasta, mover em lote); as playlists podem usar pastas inteiras (inclusive músicas futuras) e/ou músicas avulsas | Pronto e testado |
| CRUD de estações, usuários, playlists, biblioteca (upload + tags) | Pronto, testado localmente |
| Playlists agendadas por dia da semana e horário (prioridade sobre a rotação geral) | Pronto na API/painel; o script Liquidsoap gerado foi revisado, mas **não executado** |
| Crossfade, normalização de volume (ReplayGain) e até 4 streams extras com formato/bitrate próprios | Pronto na API/painel/player; script Liquidsoap revisado, **não executado** |
| DJs com usuário/senha próprios (o usuário `source` continua valendo) | Pronto na API/painel, testado; autenticação do harbor e `output.file` no Liquidsoap **não executados** |
| Relatórios de ouvintes: média/pico ao longo do tempo, países (GeoIP), players, horário de pico, com gráficos e tabela | Pronto e testado com logs de exemplo; **ainda não com o access.log real do Icecast** (ver nota abaixo) |
| Chaves de API e webhooks (Discord e JSON assinado), com proteção SSRF | Pronto e testado (24 verificações automáticas) |
| Motor simples em Node (modo `native`) para testar o áudio sem Icecast/Liquidsoap | Pronto e testado: stream em tempo real, troca de faixa, pedidos, relatórios; tocou num navegador de verdade |
| Player público, histórico, pedidos de músicas | Pronto (API testada; pedidos dependem do Liquidsoap) |
| Geração de `icecast.xml` e `radio.liq`, supervisor de processos | Escrito, **ainda não executado contra Icecast/Liquidsoap reais** |
| Imagem Docker | Escrita, **ainda não construída** |

Próximo passo imediato: subir em um servidor Linux, rodar `docker compose up --build`, criar uma estação e ajustar o que o Liquidsoap reclamar nos logs (`DATA_DIR/stations/<id>/logs/`). A sintaxe do script depende da versão do Liquidsoap fixada no `Dockerfile`.

## API e chaves de acesso

Crie uma chave em **Chaves de API** (menu superior). Ela só é mostrada uma vez e tem as mesmas permissões da sua conta (administrador vê tudo; operador, só as próprias estações). Envie em qualquer requisição:

```bash
curl -H "X-API-Key: rfk_suachave" https://radio.seudominio.com/api/stations
# ou: -H "Authorization: Bearer rfk_suachave"
```

Principais endpoints (JSON; os de estação usam o `id` numérico da estação):

| Método e caminho | O que faz |
|---|---|
| `GET /api/stations`, `GET /api/stations/:id` | Lista / detalha estações (status, ouvintes, tocando agora, links de stream) |
| `POST /api/stations/:id/start` · `stop` · `restart` | Controla a estação |
| `GET /api/stations/:id/history` | Últimas músicas tocadas |
| `GET/POST/PUT/DELETE /api/stations/:id/media` | Biblioteca (upload em `multipart/form-data`) |
| `GET/POST/PUT/DELETE /api/stations/:id/playlists` | Playlists e agendamento |
| `GET/POST/PUT/DELETE /api/stations/:id/djs` | Contas de DJ |
| `GET /api/stations/:id/reports?days=7` | Relatórios de ouvintes |
| `GET/POST/PUT/DELETE /api/stations/:id/webhooks` | Webhooks |
| `GET /api/public/stations/:slug` · `/history` · `/songs` | Dados públicos, **sem chave** (para sites e apps) |

Chaves **não** criam nem listam outras chaves; isso só é possível logado no painel.

## Webhooks

Em cada estação, aba **Integrações**. Eventos: troca de música, estação iniciada e estação parada.

- **Discord:** cole a URL de webhook do canal. A mensagem aparece como um cartão "Tocando agora".
- **Genérico:** recebe um `POST` JSON `{ event, station, data, timestamp }` com os cabeçalhos `X-RadioForge-Event` e `X-RadioForge-Signature: sha256=<HMAC do corpo com o segredo do webhook>`. Confira a assinatura antes de confiar no conteúdo.
- **Segurança (SSRF):** o servidor recusa URLs que apontem para endereços internos/privados (localhost, 10.x, 192.168.x, 169.254.x etc.) e não segue redirecionamentos, para que um operador não use webhooks para atingir serviços internos. Só em desenvolvimento, `WEBHOOK_ALLOW_PRIVATE=true` desliga essa proteção.
- Uma falha no destino nunca afeta a rádio; o último resultado aparece na lista.

## Como os relatórios funcionam

- **Ouvintes ao longo do tempo:** a cada minuto a API lê o status do Icecast e guarda uma amostra. Guardadas por 90 dias.
- **Sessões, países e players:** a API lê o `access.log` do Icecast de cada estação (ele registra cada conexão ao desconectar, com a duração). Sessões com menos de 5 s e requisições que não são de um mountpoint da estação são ignoradas. Guardadas por 365 dias.
- **Privacidade:** o IP **não** é guardado. Só um identificador anônimo (hash do IP com um segredo do servidor, usado para contar ouvintes únicos) e o país.
- **Premissa a validar:** o horário de cada linha do log é tratado como o **fim** da conexão (início = fim − duração). Confirme com um log real.
- **País por IP:** pacote `geoip-country`, que traz dados GeoLite2 da MaxMind. Leia a licença/EULA deles antes de comercializar e mantenha a atribuição exibida no painel. A base é atualizada ao atualizar o pacote.
- **Atenção no deploy:** para o IP real dos ouvintes aparecer no log, as portas de áudio (8000–8499) precisam chegar ao contêiner sem NAT/proxy que troque o IP de origem. Se todos aparecerem com o mesmo IP, é isso.

## Roadmap (comparado ao AzuraCast)

1. **Validar o motor de streaming** no Linux (item acima).
2. ~~Playlists agendadas por dia/hora~~ (feito). Também há "intercalar 1 faixa a cada N músicas" (vinhetas/avisos; só no modo Liquidsoap, **script ainda não executado**). Também "por tempo" (ex.: 60 min = uma faixa a cada início de hora, via fila de pedidos; funciona nos dois motores, intervalos alinhados ao relógio UTC).
3. ~~Crossfade, normalização de volume (ReplayGain), vários mountpoints/bitrates por estação~~ (feito).
4. ~~DJs com conta própria, gravação de transmissões ao vivo~~ (feito). O painel e o player público mostram quem está ao vivo (o Liquidsoap avisa a API ao conectar/desconectar; **não validado com um DJ real ainda**). Cada DJ pode ter janela de horário (dias + início/fim): fora dela a conexão é recusada (horário do servidor; **script não validado com Liquidsoap real**).
5. ~~Relatórios de ouvintes (por país, player, tempo) e gráficos~~ (feito, com exportação CSV: botão no painel ou `GET /api/stations/:id/reports?days=7&format=csv`). Os cartões comparam com o período anterior de mesma duração (▲/▼ %), também no CSV e em `previous` no JSON.
6. ~~Webhooks e integrações (Discord), API com chaves de acesso~~ (feito, chaves podem ser **somente leitura**: só GET/HEAD). Falta integração com redes sociais e documentação OpenAPI.
7. ~~Backups agendados~~ (feito: menu **Backups**, só admin; cópia diária do banco, guarda as 7 últimas, download pelo painel; **não inclui músicas/gravações**, copie o volume `/data` para elas). **Enviar backup** (arquivo `.db` baixado de outro servidor, até 500 MB, conferido antes de entrar na lista) para levar as configurações a uma instalação nova: no servidor novo crie um administrador qualquer, envie o arquivo em Backups, clique em Restaurar e depois entre com o usuário e a senha do servidor antigo. **Restaurar** pelo painel (guarda antes uma cópia de segurança do banco atual e reinicia a API; depende de o Docker religar o contêiner, o que `restart: unless-stopped` faz). Menu **Sistema** (admin): mostra versão/commit em uso e verifica se há commit novo no GitHub (repositório privado: defina `UPDATE_GITHUB_TOKEN`, token só de leitura; `UPDATE_REPO`, `UPDATE_BRANCH` opcionais); o botão "Atualizar agora" chama `UPDATE_WEBHOOK_URL` se definida (senão, o deploy automático do seu painel já atualiza a cada push). 
8. Relay/transmissão para outros serviços, HTTPS automático (Caddy) e multi-idioma.
9. Migrar SQLite para Postgres se o volume pedir.

## Cloudflare e proxies, AAC e processador de áudio

- **Atrás de proxy/Cloudflare:** o painel mostra, para cada stream, um link que passa pelo próprio painel (`https://seu-dominio/listen/<estação>/<nome>`, ex.: `/listen/minha-radio/radio.mp3`; o endereço antigo `/stream/...` continua funcionando). Ele usa só a porta do site, então funciona com o domínio proxied pelo Cloudflare, sem abrir as portas 8000+. O player público também usa esse caminho. O "link direto" (`dominio:porta`) só funciona com a porta aberta e DNS sem proxy (nuvem cinza). O Cloudflare não guarda o stream (`Cache-Control: no-store`).
- **DJ ao vivo** conecta direto na porta do Liquidsoap (não passa pelo proxy): use o IP do servidor ou um subdomínio "somente DNS", ou defina `PUBLIC_HOST` para esse endereço.
- **Formatos:** MP3, **AAC** (AAC-LC via FFmpeg do Liquidsoap, mountpoint padrão `/radio.aac`) e OGG. AAC e OGG só no modo Liquidsoap; o modo simples (Node) serve só MP3. Gravações de DJ em AAC são salvas em MP3. **O encoder AAC ainda não foi executado num Liquidsoap real**: se der erro ao iniciar, o painel mostra a mensagem.
- **Processador de áudio** (Configurações): `Equilibrado` (compressão leve + limitador) e `Forte, estilo FM` (normaliza + compressão firme + limitador). Vale para tudo que vai ao ar (músicas e DJ), só no modo Liquidsoap. Os parâmetros ainda não foram validados num Liquidsoap real; padrão desligado.
- **Histórico:** o painel mostra 5/10/20/50 últimas músicas (a escolha fica no navegador); o player público mostra exatamente a quantidade definida em Configurações (padrão 5, sem "Ver mais").

## Vinhetas e pedidos por playlist

- **Vinheta** (opção da playlist): toca normalmente, mas o nome do arquivo **não é enviado ao servidor**: não aparece em "Tocando agora", no histórico nem nos webhooks. No Liquidsoap, as faixas vão no `.m3u` com `annotate:rf_jingle="1":` e o `notify` ignora essas faixas (**script ainda não executado num Liquidsoap real**); no motor simples, a faixa é tocada sem anunciar. Vale também para playlists por tempo e "a cada N músicas". Vinheta não pode ser pedida.
- **Pedidos por playlist:** o ouvinte só vê (e só pode pedir) músicas de playlists ativas com **"Permitir pedidos desta playlist"** ligado, além de a estação ter "Permitir pedidos" nas Configurações. Playlists antigas começam com pedidos desligados.

## Progresso de envio

Ao enviar músicas (Biblioteca), o painel mostra o andamento: barra total com porcentagem, MB enviados, velocidade e tempo restante, e uma lista por arquivo (na fila, enviando %, processando, enviado ou erro). Dá para cancelar o envio; arquivos com erro ficam listados até você fechar o painel.

## Volume, não repetir músicas e biblioteca por pastas

- **Volume do auto DJ:** o processador de áudio agora vem **ligado (Equilibrado)** em estações novas e foi ligado nas existentes que estavam desligadas (migração única). Cadeia: normalizador → compressor → ganho extra opcional (**Volume extra**, 0 a +12 dB) → **limitador no fim**, que impede estouro/distorção. Se o Liquidsoap recusar algum parâmetro, a estação tenta uma versão com valores padrão e, em último caso, sobe sem processador, **mostrando um aviso** no painel (a rádio não cai por causa disso). Parâmetros ainda não validados num Liquidsoap real.
- **Não repetir músicas:** em Configurações, "Não repetir a mesma música por N minutos" (padrão 60 em estações novas; 0 desliga). As músicas tocadas há menos tempo saem das playlists (o Liquidsoap recarrega o `.m3u`; o motor simples escolhe sem elas), não podem ser pedidas pelos ouvintes ("Tocou há pouco") e voltam sozinhas depois do prazo. Se todas já tocaram (biblioteca pequena), a rádio continua tocando, só evita repetir a faixa anterior. Vinhetas não entram na regra.
- **Biblioteca:** o início mostra as **pastas** e, abaixo, só as músicas **sem pasta**; abrir uma pasta mostra as músicas dela. Dá para soltar arquivos sobre uma pasta para enviar direto. A busca procura em toda a biblioteca.

## Playlist padrão

Marque uma playlist como **padrão** (a primeira playlist de uma estação já nasce padrão): ela é a **rotação base e toca sempre**, sem se misturar com as outras. As demais só entram pela regra de cada uma: **a cada N músicas da padrão** (ex.: 1 vinheta a cada 3 músicas), **em dia e horário** ou **por tempo** (a cada N minutos). Playlist sem regra, com padrão definida, **não toca** (o painel avisa). A padrão não tem regras próprias, não pode ser vinheta e só existe uma por estação. Sem padrão, vale o comportamento antigo (playlists misturadas por peso). Vale no Liquidsoap e no motor simples (que agora também faz o "a cada N músicas").

## Metadados e capas

- **Metadados no stream:** o Liquidsoap envia título/artista de cada faixa ao Icecast (ICY), então VLC e apps de rádio mostram "Artista - Música". Pelo link do painel (`/listen/<estação>/<nome>`, que funciona atrás do Cloudflare) os metadados ICY também passam quando o player os pede (`Icy-MetaData: 1`). Vinhetas saem com o **nome da estação** no lugar das tags do arquivo (e sem avisar o servidor). O motor simples (Node) não envia ICY.
- **Capas:** a capa embutida nas tags do arquivo (ID3/MP4/FLAC) é extraída no envio (e nas músicas já enviadas, em segundo plano ao iniciar a API) e aparece no "Tocando agora" do painel e do player público, nos históricos e na biblioteca; no celular também na tela de bloqueio (Media Session). Link público: `/api/public/stations/<slug>/cover/<id>`. Músicas sem capa embutida mostram um ícone.
- **Icecast:** está instalado na imagem Docker (`icecast2`); `GET /api/health` mostra `engineMode: liquidsoap` quando Icecast + Liquidsoap estão em uso.

**Capa da rádio:** em Configurações → Capa da rádio (só admin) envie um logo (PNG/JPG/WEBP/GIF, até 4 MB; o tipo é conferido pelo conteúdo do arquivo). Ela entra **no lugar da capa das músicas que não têm** ("Tocando agora" do painel e do player, históricos, tela de bloqueio do celular), aparece no player quando nada está tocando e na lista de estações.

## Ouvintes em tempo real

Aba **Ouvintes** (e o cartão "Ouvintes agora" do painel): lista quem está conectado **agora**, com **IP, país (bandeira), aparelho (celular/computador/TV… + sistema), player (Chrome, VLC, app…), stream e há quanto tempo**, atualizando a cada 5 s. A contagem do painel e do player público vem da mesma fonte: cada conexão aberta no Icecast (`/admin/listclients`), no lugar do total do `status-json`. Os IPs aparecem só ao vivo e **não são guardados** (os relatórios continuam só com identificador anônimo + país). A localização é só o **país** (a base GeoLite2-Country não tem cidade). Atrás do Cloudflare o IP vem de `CF-Connecting-IP`. **Ainda não validado contra um Icecast real**: se a lista vier vazia com gente ouvindo, a causa provável é o `listclients` ou o IP repassado pelo `X-Forwarded-For`; o total então cai no valor do `status-json`.

**Como os ouvintes são contados (correção):** todo link do painel/player (`/stream/<estação>/<nome>` e o player do site) passa pela API, que conta cada conexão aberta **com o IP real** (`CF-Connecting-IP` atrás do Cloudflare) — não depende do Icecast. O Icecast (`/admin/listclients`) só é consultado para quem entra pelo **link direto** (porta do stream); a conexão do proxy leva o sufixo `RF-Proxy/1` no User-Agent para não ser contada duas vezes. Se o Icecast não puder ser consultado, a aba Ouvintes avisa e continua mostrando os do proxy.

## Ao vivo (encoder) e AutoDJ

- **Como funciona:** quando um encoder (BUTT, Mixxx, OBS…) conecta com usuário/senha de DJ (ou `source`), assume **na hora**, cortando o AutoDJ; quando ele desconecta ou cai, o AutoDJ **volta sozinho**. Prioridade: DJ ao vivo > pedidos > rotação das playlists.
- **Queda sem aviso (internet cortou):** o AutoDJ volta depois de N segundos sem sinal do encoder, configurável em Configurações → "AutoDJ volta após" (padrão **8 s**; o padrão do Liquidsoap era 30 s, com silêncio no meio). Usa `settings.harbor.timeout`.
- **Voltar ao AutoDJ agora:** botão no Painel (aparece quando há DJ no ar) derruba o encoder atual (`live.stop` no telnet local do Liquidsoap); o DJ pode reconectar se o programa dele tentar de novo.
- **Não validado num Liquidsoap real:** o comando `live.stop` e o `settings.harbor.timeout`; se algum não for aceito, o painel mostra o erro ao iniciar a estação ou ao clicar no botão.
- **AutoDJ continua a música ao voltar do ao vivo** (Configurações → "AutoDJ continua a música…", ligado por padrão): durante o DJ, o AutoDJ segue tocando **mudo** em segundo plano (`output.dummy` sobre a fonte automática); quando o encoder cai, entra a música que estiver tocando naquele momento, em vez de recomeçar numa faixa nova. Enquanto há DJ no ar, **pedidos de ouvintes e vinhetas por tempo ficam suspensos** (tocariam mudos). Se o Liquidsoap recusar essa parte, a estação sobe sem ela e o painel avisa. Desligado, o comportamento depende da versão do Liquidsoap (versões novas começam uma faixa nova). Para o tempo de queda, use "AutoDJ volta após" (3 a 60 s; coloque 5).

**Biblioteca:** marque as músicas (ou "selecionar todas" no cabeçalho da tabela, que seleciona as que estão na tela) e use **Excluir selecionadas** para apagar em lote, com confirmação mostrando a quantidade (`POST /api/stations/:id/media/delete`). Os arquivos e as capas são apagados e as playlists atualizadas de uma vez.

## Hora certa

Em Configurações → **Hora certa**: a cada hora, 30 ou 15 min o AutoDJ avisa a hora com voz sintética em português do Brasil, ex.: "Hora certa. São catorze horas e meia." (horas e minutos por extenso, com o gênero certo: "uma hora", "duas horas", "meio-dia", "meia-noite"). A hora usa o **fuso escolhido** (padrão America/Sao_Paulo; o servidor costuma estar em UTC). O aviso entra na fila de pedidos e **toca ao fim da música atual** (pode atrasar alguns minutos em relação ao relógio), não aparece em "Tocando agora", histórico nem webhooks e **não toca com DJ ao vivo**. Botões: **Ouvir exemplo** (gera no servidor e toca no navegador) e **Tocar agora na rádio**. Os áudios ficam em cache em `data/stations/<id>/announce`. A voz é o **espeak-ng** (instalado na imagem Docker; a instalação é protegida: se falhar ou quebrar o Liquidsoap, é removida e a hora certa fica indisponível, com mensagem no painel). A voz é robótica; só no modo Liquidsoap (o motor simples toca só MP3). **Ainda não executado num Liquidsoap real** (toca um `.wav` pela fila de pedidos).

**Hora certa com os seus áudios:** em Configurações → Hora certa → **Seus arquivos de áudio**, envie os arquivos de uma vez; a hora vem do **nome**: `00.mp3`…`23.mp3` (hora cheia), `14h30.mp3` / `14-30.mp3` / `1430.mp3` (meia hora), `hora_14.mp3`, `meio-dia.mp3`, `meia-noite.mp3`. Cada arquivo é **verificado** (formato MP3/WAV/OGG/FLAC/M4A/AAC, até 10 MB e 60 s, áudio legível e não vazio) e o painel mostra um relatório (aceito em tal horário / motivo da recusa); mesmo horário enviado de novo **substitui**; um arquivo com outro nome pode ser enviado direto num horário pelo botão da grade. A grade mostra por horário: ouvir, trocar e excluir, e avisa quais horários estão sem arquivo. **Escolha do áudio na hora:** 1) o arquivo enviado para exatamente aquele horário; 2) senão a voz sintética (se "Usar a voz sintética quando não houver arquivo" estiver ligado); 3) senão a rádio não avisa naquele horário. Para só usar seus áudios, desligue a voz sintética.

**Hora certa com áudios por minuto, enviados em ZIP (substitui a grade por horário acima):** monte um **único ZIP** com todos os áudios (pode ter pastas e várias vozes; até 400 MB) e envie em Configurações → Hora certa → **Enviar ZIP**. O servidor lê o nome de cada arquivo e processa tudo em segundo plano, com barra de progresso. Padrão de nome: `masculino_00_02.mp3` = voz **masculino**, hora **00**, minuto **02** (um arquivo por minuto do dia, 1440 por voz; também valem `14h30.mp3`, `14-30.mp3`, `14.mp3`, e a voz vem da pasta ou fica "padrao"). Cada arquivo é verificado (formato, 10 MB, 60 s, áudio legível); o relatório lista os recusados com o motivo; reenviar substitui. O painel mostra cada **voz** (quantos minutos cobre, o que falta, excluir) e você escolhe a **voz em uso**. Testado com 3 vozes reais (4318 arquivos, 145 MB): processado em ~30 s. **Escolha do áudio:** a voz em uso para aquele minuto → o mesmo minuto em outra voz enviada → voz sintética (se ligada) → não avisa. Como o aviso toca só ao fim da música atual, o servidor **estima esse instante** (início da faixa + duração) e fala o **minuto em que vai tocar**. Intervalos: 5, 10, 15, 20, 30 ou 60 min. Proteções do ZIP: nomes do ZIP nunca definem onde gravar (sem "zip slip"), limite de entradas e de tamanho descompactado, lixo de sistema (`__MACOSX`) ignorado.

## AutoCue (passagens profissionais)

Em Configurações → Qualidade do áudio → **AutoCue**: o Liquidsoap analisa cada música ao prepará-la (início e fim reais, ignorando silêncio, volume e ponto de sobreposição, via `enable_autocue_metadata()`) e o `crossfade` passa a seguir esses pontos: a música seguinte (ou a **vinheta**, ou o **aviso de hora**) entra no momento certo, sem cortar o final da anterior e sem silêncio entre elas. Como músicas, vinhetas, pedidos e a hora certa passam pela mesma fonte, a regra vale em **todas as passagens** (música→vinheta, música→hora, hora→música…). Vinhetas e avisos levam fades curtos (`liq_fade_in/out = 0.10`) para não estalar. Substitui o crossfade fixo (que fica desativado com o AutoCue ligado). Só no modo Liquidsoap (o motor simples não faz crossfade); em estações novas vem ligado, nas existentes é preciso ligar. A análise usa um pouco de CPU na primeira vez que cada faixa toca. **Não validado num Liquidsoap real**: se ele recusar o script, a estação sobe sem o AutoCue e o painel avisa (cada recurso opcional — AutoCue, AutoDJ em segundo plano e processador de áudio — é desligado sozinho se for recusado). Para ainda mais controle dá para usar o projeto externo `autocue` (cue_file) no futuro.

### AutoCue personalizável, vinhetas sem cortes e Configurações em cards

- **Vinhetas e hora certa** entram com cue exato (começam em 0 e vão até o fim real do arquivo), sem pular silêncio e **sem sobreposição por padrão**: vinheta→vinheta não corta no meio. A sobreposição pode ser ajustada em *Configurações → AutoCue e passagens*.
- O AutoCue também processa vinhetas e avisos de hora (análise + nivelamento `liq_amplify`), com **ganho extra (dB)** só para elas.
- Painel: duração e fades da passagem entre músicas (opcional, senão usa o padrão do Liquidsoap). Se o Liquidsoap recusar os valores personalizados, a estação cai sozinha para o AutoCue padrão e depois para desligado (aviso no painel).
- **Configurações** agora é uma grade de cards; cada um abre um modal. O botão *Salvar alterações* fica fixo no rodapé.
- **Player público**: ícone de volume (silenciar) e controle deslizante; o volume fica salvo no navegador.

### Ocultar nomes (metadados)

Em *Configurações → Ocultar nomes*, liste palavras (uma por linha). Faixas cujo título, artista, álbum ou nome do arquivo contenham alguma delas tocam normalmente, mas **sem enviar metadados**: não entram em "Tocando agora", histórico, webhooks nem no stream, e o nome da estação também não é enviado. Há ainda a opção de as vinhetas não enviarem o nome da estação como título.

### Stereo Tool

Em *Configurações → Stereo Tool*: envie o ZIP do plugin do Stereo Tool (uma vez para o servidor; vale para todas as estações), o preset `.sts` de cada estação, cole a **sua** chave de licença (uma só, vale para todas as estações) e ligue. O Liquidsoap carrega a biblioteca (`stereotool(library_file, license_key, preset, ...)`) no lugar do processador interno. A chave fica só no servidor e nunca volta para o navegador. Se o Liquidsoap recusar o script (por exemplo, build sem suporte a Stereo Tool), a rádio sobe com o processador interno e o painel avisa. O Stereo Tool consome bastante CPU: ligue só onde precisar.

### Rotação pela API e não repetir música/artista

O painel passou a escolher a próxima faixa de cada playlist (o Liquidsoap pergunta por HTTP, `request.dynamic`). Assim valem, de verdade: **não repetir a mesma música por N minutos** e **não repetir o mesmo artista por N minutos** (feats/participações contam como o artista principal), inclusive para faixas ocultas, pedidos e playlists por tempo, e as playlists `.m3u` deixam de ser regravadas a cada música (isso recarregava o Liquidsoap e refazia a análise do AutoCue). Se não houver faixa que obedeça às regras, o painel relaxa primeiro o artista e depois a música, nunca deixa a rádio muda. Se o Liquidsoap recusar o script ou não pedir faixas ao subir, a estação volta sozinha às playlists comuns e o painel avisa.

### Blocos comerciais

Menu **Comerciais**: crie uma pasta na Biblioteca com os comerciais e programe um bloco com **horários** (no fuso da estação), **dias da semana**, quantos comerciais por bloco e a ordem (em ordem ou aleatória). No horário o bloco entra na fila do AutoDJ e toca ao fim da música atual, sem aparecer em "Tocando agora" nem no histórico. Cada comercial colocado no ar fica em **Veiculações recentes** (data, hora e arquivo), como comprovante. Há **Disparar agora** para testar. Blocos não disparam com DJ ao vivo (ficam registrados como "Pulado") nem em estações sem AutoDJ. Não deixe a pasta dos comerciais dentro de uma playlist, senão eles também tocam na programação normal.

### Esqueci minha senha (e-mail)

A tela de login tem **Esqueci minha senha**: o usuário informa o e-mail e recebe um link (válido por 1 hora, uso único) para criar uma nova senha. O envio usa SMTP: configure em **Sistema → E-mail** (servidor, porta, usuário, senha, remetente e botão de teste) ou pelas variáveis `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` (têm prioridade). A resposta do painel é a mesma exista o e-mail ou não, e há limite de 5 pedidos por hora por IP e por e-mail.

### Migração do AzuraCast: links de stream

Os links `https://seu-dominio/listen/<estação>/<mount>` seguem o mesmo formato do AzuraCast. Para que os links antigos dos clientes toquem no painel novo: (1) crie a estação com o **mesmo endereço curto** (ex.: `up80`) e o **mesmo nome de stream** que o cliente usa; (2) no Velix, adicione o domínio antigo (ex.: `stm.seudominio.com.br`) ao serviço do painel e aponte o DNS (registro A) para o IP do servidor, com o proxy do Cloudflare ligado (nuvem laranja) ou desligado (nuvem cinza): o painel responde nos dois casos. Se o nome do arquivo no link não bater (ex.: `/radio.mp3` em vez de `/stream`), o painel entrega o stream principal da estação em vez de dar erro. Defina `PUBLIC_ORIGIN=https://stm.seudominio.com.br` para os links mostrados no painel usarem esse endereço. Links diretos por IP:porta (`http://IP:8010/stream`) também funcionam enquanto a porta da estação estiver liberada no firewall.

### API compatível com o AzuraCast

Para sites, apps e widgets que já consumiam o AzuraCast continuarem funcionando: `GET /api/nowplaying` (todas as estações), `GET /api/nowplaying/<estação>` e `GET /api/nowplaying_static/<estação>.json` (a estação pode ser o endereço curto ou o número) devolvem `station`, `listeners`, `live`, `now_playing` (com `song`, `duration`, `elapsed`, `remaining`), `playing_next`, `song_history` e `is_online` no mesmo formato; `GET /api/station/<estação>` traz os dados e os mounts; `/public/<estação>` abre o player; `/public/<estação>/playlist.pls` e `.m3u` baixam a playlist do stream. São públicas e com CORS liberado. Diferenças: `playing_next` vem vazio (o painel ainda não prevê a próxima faixa) e `/api/stations` continua sendo a lista autenticada do painel.

### Encoders vindos do AzuraCast (DJ ao vivo)

A porta do DJ é a **porta da estação + 5** (como no AzuraCast; ajuste a porta em *Editar estação* para ficar igual à antiga). O painel aceita o mount `/live` **e também `/`** (padrão do AzuraCast), e as senhas no formato `usuário:senha` (senha do encoder) além de usuário + senha normais. Os DJs/streamers precisam ser recriados em **DJs** (as senhas não são importadas). Se o Liquidsoap recusar o mount `/`, a estação sobe só com `/live` e o painel avisa no log.

### Links por porta com HTTP **e** HTTPS (estilo AzuraCast)

Cada rádio atende, na própria porta (ex.: `8070`), tanto `http://dominio:8070/stream` quanto `https://dominio:8070/stream`, além de `https://dominio/listen/<estação>/stream`. O painel abre a porta pública de cada estação (aceita HTTP e HTTPS na mesma porta, identificando pelo primeiro byte) e repassa para o Icecast, que passa a escutar só em `127.0.0.1` (porta interna = porta da estação + 10000, nunca exposta). Pedidos de ouvinte levam o IP real para a contagem; encoders (`SOURCE`/`PUT`) passam sem alteração. Vale para todas as rádios, novas e antigas, com a porta de cada uma.

Para o HTTPS das portas: em **Sistema → HTTPS nas portas das rádios** informe o domínio (ex.: `stm.seudominio.com.br`) e clique em *Salvar e emitir certificado*. O painel pede e renova sozinho o certificado Let's Encrypt (desafio HTTP-01 em `/.well-known/acme-challenge/`, que chega ao painel pela porta 80 do domínio no Velix). Requisitos: o domínio aponta para o IP do servidor, as portas das rádios (8000–8499) estão publicadas no servidor/firewall e, para as portas funcionarem, o registro no Cloudflare fica em "somente DNS" (nuvem cinza), pois o Cloudflare não repassa essas portas. O link `https://dominio/listen/...` continua funcionando com o proxy do Cloudflare ligado ou não. Dá para informar **vários domínios** (até 50, um por linha), todos num só certificado, como no AzuraCast: antes de emitir, o painel testa quais chegam a ele pela porta 80 e emite só para esses, avisando os que ficaram de fora (um domínio errado não derruba os outros).

### Permissões dos operadores
Em **Usuários** (novo ou editar) o administrador marca o que cada operador pode fazer: controlar a rádio, biblioteca, playlists, comerciais, DJs, relatórios, cancelar pedidos, editar a estação/configurações e preset do Stereo Tool (enviar e escolher, no menu Stereo Tool) e ajustes avançados (áudios da hora certa e log do Liquidsoap). O que não foi marcado some do menu e é bloqueado no servidor (403), inclusive por chave de API. Operadores antigos (sem lista salva) mantêm o que já podiam. Criar/excluir estações, usuários, backups e configurações do sistema continuam só com administradores.

### SFTP para enviar músicas
Na **Biblioteca**, botão **SFTP**: cada estação ganha usuário e senha próprios (gerados ao ligar; dá para trocar). Em FileZilla/WinSCP, conecte em `<servidor>:2222` (variável `SFTP_PORT`; `0` desliga). A raiz é a biblioteca da estação, com as pastas como diretórios; dá para enviar, baixar, renomear, mover e apagar músicas (só áudio). O acesso não alcança configurações e não para nem reinicia a rádio: as músicas enviadas são importadas (tags e capa) e as playlists são atualizadas em lote, alguns segundos depois do último envio. É preciso **publicar a porta 2222** do contêiner (no Velix, como as portas das rádios). A chave do servidor fica em `.secrets/sftp_host_ed25519` (persistente no volume), então o aviso de "chave nova" não reaparece a cada deploy. 10 senhas erradas seguidas bloqueiam o IP por 10 minutos.

### Sessão do painel
O login expira após **3 horas sem atividade**. Enquanto a pessoa usa o painel (mouse, teclado, toque ou rolagem) ou há um envio de arquivos em andamento, o navegador renova o login sozinho. As consultas automáticas do painel (ouvintes, now playing) não contam como atividade. Chaves de API não expiram.

### Desempenho (menos CPU, mesma qualidade)
- **AutoCue + ReplayGain:** com o AutoCue e o nivelamento dele ligados, o ReplayGain não roda (era uma segunda análise de volume de cada faixa e um segundo ganho em cima do primeiro).
- **Verificação do script:** o `liquidsoap --check` só roda quando o script da estação muda (resultado guardado em `/tmp` do contêiner); reinícios iguais não recompilam.
- **Banco:** SQLite com `synchronous=NORMAL` (WAL) e cache maior: menos fsync a cada gravação de histórico/sessão.
- **Consultas repetidas:** a resposta pública de cada estação (player, widgets, API compatível com AzuraCast) fica 3 s em cache; consultas simultâneas à lista de ouvintes do Icecast dividem uma só.
- **Painel aberto:** as telas do painel param de atualizar com a aba escondida; a da estação atualiza a cada 10 s.
- **Logs:** Icecast em nível de aviso (menos escrita) e logs de Icecast/Liquidsoap rotacionados acima de 5 MB.

### Cache do AutoCue (a música é analisada uma vez só)
A análise do AutoCue (início/fim reais, fades, sobreposição e volume de cada faixa) é a parte mais pesada do Liquidsoap. Na **primeira vez** que uma música toca, o Liquidsoap avisa o resultado e ele é guardado no banco (`media_cue`); nas vezes seguintes o painel entrega esses valores junto com a faixa e o Liquidsoap **pula a análise** (ele já faz isso quando `liq_cue_in`/`liq_cue_out` vêm na faixa). Detalhes:
- vale para a rotação pela API (padrão), pedidos e playlists por horário; no modo de playlists `.m3u` entra a partir da próxima reescrita da playlist;
- só funciona com o AutoCue ligado na estação; se o Liquidsoap recusar o trecho de aprendizado, a rádio sobe normalmente sem ele (e analisa sempre, como antes);
- `AUTOCUE_CACHE=false` desliga o cache (volta a analisar sempre);
- para refazer as análises de uma estação: `DELETE /api/stations/:id/media/cue-cache`.

### Processador de áudio: master_me (plugin do AzuraCast)
Em **Configurações → Processador de áudio**, a predefinição "master_me" usa o plugin LADSPA master_me (projeto trummerschlunk/master_me no GitHub) — o mesmo processador de volume (leveler + compressor multibanda + limitador) que o AzuraCast oferece. A imagem baixa o `.so` já compilado e instala em `/usr/lib/ladspa` (instalação protegida: se falhar ou quebrar o Liquidsoap, é removido e a imagem segue sem ele). Os parâmetros são os mesmos do preset "Music General" do AzuraCast (alvo de -14 LUFS); o "Volume extra" da tela vira o ganho de entrada do próprio plugin. Diferente do processador interno, o master_me entra sozinho na cadeia (sem o normalizador/compressor/limitador do painel), porque ele já faz tudo isso dentro de si. Se o plugin não estiver instalado ou o Liquidsoap recusar o script, o painel cai para a versão com os valores padrão do plugin e, por fim, sem processamento — avisando na tela o que aconteceu.

### Pedidos dos ouvintes: não repetir música nem artista
O pedido passa pelas mesmas regras de "não repetir" do AutoDJ ("não repetir música" e "não repetir artista", em Configurações): se a música ou o artista tocaram há pouco, o pedido é recusado com o motivo. Essa checagem olha o histórico (o que já tocou de verdade) **e** o que acabou de ser escolhido ou pedido e ainda nem começou a tocar — por isso dois pedidos da mesma música em segundos um do outro não passam os dois (antes, só o histórico era checado, e o histórico só grava quando a faixa realmente começa a tocar). Outras regras do pedido: só música de playlist com "Permitir pedidos" ligado, intervalo mínimo entre pedidos do mesmo ouvinte (por IP), AutoDJ precisa estar ligado e sem DJ ao vivo no ar, e dá para configurar um atraso antes de entrar na fila.

### Vinhetas de bloco comercial (saída e entrada)
Em **Comerciais**, dá para escolher uma playlist marcada como "Jingle (vinheta)" para tocar **antes** de qualquer bloco comercial disparado ("vinheta de saída") e outra para tocar **depois**, antes de a programação normal voltar ("vinheta de entrada"). Funciona pela mesma fila de pedidos do Liquidsoap que já existia (sem mexer no script): a vinheta de saída entra na fila, depois os comerciais do bloco, depois a de entrada — tudo na ordem, um atrás do outro. Com mais de uma música na playlist escolhida, cada disparo toca a próxima (cursor salvo na estação), não a mesma sempre nem ao acaso; com uma só, toca sempre ela. Ajuda passo a passo no botão "Ajuda" da própria página.

### Playlist exclusiva por horário, com vinheta própria da janela
Uma playlist **agendada** (dias + horário) já tinha prioridade sobre a rotação normal: durante a janela, só ela toca (a padrão e as demais ficam de fora e voltam sozinhas ao terminar, sem cortar a música no meio — é o `fallback(track_sensitive = true, ...)` do Liquidsoap). Agora dá para ter vinhetas exclusivas dessa janela também: marque uma playlist como **Jingle** e agende nela **os mesmos dias e horário** da playlist de música, com "a cada N músicas" preenchido. Enquanto essa janela durar, a vinheta agendada entra a cada N músicas **dentro** da playlist de música daquele horário, e as vinhetas comuns (as de fora da janela) ficam de fora junto com o resto da rotação. Sem uma playlist de música com o mesmo horário exato, a vinheta agendada fica pronta mas não entra em lugar nenhum — o painel não avisa esse caso hoje, por isso o horário dos dois precisa bater certinho (ajuda passo a passo no botão "Ajuda" de Playlists).
