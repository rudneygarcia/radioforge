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
| `liquidsoap` | Icecast e Liquidsoap instalados (imagem Docker) | Tudo: DJ ao vivo, crossfade, normalização, gravação, vários formatos/bitrates |
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
| DJs com usuário/senha próprios (o usuário `source` continua valendo) e gravação das transmissões ao vivo, com download | Pronto na API/painel, testado; autenticação do harbor e `output.file` no Liquidsoap **não executados** |
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
| `GET /api/stations/:id/recordings` | Gravações das transmissões ao vivo |
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
7. ~~Backups agendados~~ (feito: menu **Backups**, só admin; cópia diária do banco, guarda as 7 últimas, download pelo painel; **não inclui músicas/gravações**, copie o volume `/data` para elas). **Restaurar** pelo painel (guarda antes uma cópia de segurança do banco atual e reinicia a API; depende de o Docker religar o contêiner, o que `restart: unless-stopped` faz). Menu **Sistema** (admin): mostra versão/commit em uso e verifica se há commit novo no GitHub (repositório privado: defina `UPDATE_GITHUB_TOKEN`, token só de leitura; `UPDATE_REPO`, `UPDATE_BRANCH` opcionais); o botão "Atualizar agora" chama `UPDATE_WEBHOOK_URL` se definida (senão, o deploy automático do seu painel já atualiza a cada push). **Podcast** (aba por estação): envie episódios (ou publique uma gravação ao vivo) e use o feed RSS `/api/public/stations/<slug>/podcast.xml` em qualquer app de podcast (com suporte a Range; rascunhos ficam fora do feed).
8. Relay/transmissão para outros serviços, HTTPS automático (Caddy) e multi-idioma.
9. Migrar SQLite para Postgres se o volume pedir.

## Cloudflare e proxies, AAC e processador de áudio

- **Atrás de proxy/Cloudflare:** o painel mostra, para cada stream, um link que passa pelo próprio painel (`https://seu-dominio/stream/<estação>/<nome>`, ex.: `/stream/minha-radio/radio.mp3`). Ele usa só a porta do site, então funciona com o domínio proxied pelo Cloudflare, sem abrir as portas 8000+. O player público também usa esse caminho. O "link direto" (`dominio:porta`) só funciona com a porta aberta e DNS sem proxy (nuvem cinza). O Cloudflare não guarda o stream (`Cache-Control: no-store`).
- **DJ ao vivo** conecta direto na porta do Liquidsoap (não passa pelo proxy): use o IP do servidor ou um subdomínio "somente DNS", ou defina `PUBLIC_HOST` para esse endereço.
- **Formatos:** MP3, **AAC** (AAC-LC via FFmpeg do Liquidsoap, mountpoint padrão `/radio.aac`) e OGG. AAC e OGG só no modo Liquidsoap; o modo simples (Node) serve só MP3. Gravações de DJ em AAC são salvas em MP3. **O encoder AAC ainda não foi executado num Liquidsoap real**: se der erro ao iniciar, o painel mostra a mensagem.
- **Processador de áudio** (Configurações): `Equilibrado` (compressão leve + limitador) e `Forte, estilo FM` (normaliza + compressão firme + limitador). Vale para tudo que vai ao ar (músicas e DJ), só no modo Liquidsoap. Os parâmetros ainda não foram validados num Liquidsoap real; padrão desligado.
- **Histórico:** o painel mostra 5/10/20/50 últimas músicas (a escolha fica no navegador); o player público mostra a quantidade definida em Configurações (padrão 5, com "Ver mais").

## Vinhetas e pedidos por playlist

- **Vinheta** (opção da playlist): toca normalmente, mas o nome do arquivo **não é enviado ao servidor**: não aparece em "Tocando agora", no histórico nem nos webhooks. No Liquidsoap, as faixas vão no `.m3u` com `annotate:rf_jingle="1":` e o `notify` ignora essas faixas (**script ainda não executado num Liquidsoap real**); no motor simples, a faixa é tocada sem anunciar. Vale também para playlists por tempo e "a cada N músicas". Vinheta não pode ser pedida.
- **Pedidos por playlist:** o ouvinte só vê (e só pode pedir) músicas de playlists ativas com **"Permitir pedidos desta playlist"** ligado, além de a estação ter "Permitir pedidos" nas Configurações. Playlists antigas começam com pedidos desligados.

## Progresso de envio

Ao enviar músicas (Biblioteca) ou episódios (Podcast), o painel mostra o andamento: barra total com porcentagem, MB enviados, velocidade e tempo restante, e uma lista por arquivo (na fila, enviando %, processando, enviado ou erro). Dá para cancelar o envio; arquivos com erro ficam listados até você fechar o painel.

## Volume, não repetir músicas e biblioteca por pastas

- **Volume do auto DJ:** o processador de áudio agora vem **ligado (Equilibrado)** em estações novas e foi ligado nas existentes que estavam desligadas (migração única). Cadeia: normalizador → compressor → ganho extra opcional (**Volume extra**, 0 a +12 dB) → **limitador no fim**, que impede estouro/distorção. Se o Liquidsoap recusar algum parâmetro, a estação tenta uma versão com valores padrão e, em último caso, sobe sem processador, **mostrando um aviso** no painel (a rádio não cai por causa disso). Parâmetros ainda não validados num Liquidsoap real.
- **Não repetir músicas:** em Configurações, "Não repetir a mesma música por N minutos" (padrão 60 em estações novas; 0 desliga). As músicas tocadas há menos tempo saem das playlists (o Liquidsoap recarrega o `.m3u`; o motor simples escolhe sem elas), não podem ser pedidas pelos ouvintes ("Tocou há pouco") e voltam sozinhas depois do prazo. Se todas já tocaram (biblioteca pequena), a rádio continua tocando, só evita repetir a faixa anterior. Vinhetas não entram na regra.
- **Biblioteca:** o início mostra as **pastas** e, abaixo, só as músicas **sem pasta**; abrir uma pasta mostra as músicas dela. Dá para soltar arquivos sobre uma pasta para enviar direto. A busca procura em toda a biblioteca.

## Playlist padrão

Marque uma playlist como **padrão** (a primeira playlist de uma estação já nasce padrão): ela é a **rotação base e toca sempre**, sem se misturar com as outras. As demais só entram pela regra de cada uma: **a cada N músicas da padrão** (ex.: 1 vinheta a cada 3 músicas), **em dia e horário** ou **por tempo** (a cada N minutos). Playlist sem regra, com padrão definida, **não toca** (o painel avisa). A padrão não tem regras próprias, não pode ser vinheta e só existe uma por estação. Sem padrão, vale o comportamento antigo (playlists misturadas por peso). Vale no Liquidsoap e no motor simples (que agora também faz o "a cada N músicas").

## Metadados e capas

- **Metadados no stream:** o Liquidsoap envia título/artista de cada faixa ao Icecast (ICY), então VLC e apps de rádio mostram "Artista - Música". Pelo link do painel (`/stream/<estação>/<nome>`, que funciona atrás do Cloudflare) os metadados ICY também passam quando o player os pede (`Icy-MetaData: 1`). Vinhetas saem com o **nome da estação** no lugar das tags do arquivo (e sem avisar o servidor). O motor simples (Node) não envia ICY.
- **Capas:** a capa embutida nas tags do arquivo (ID3/MP4/FLAC) é extraída no envio (e nas músicas já enviadas, em segundo plano ao iniciar a API) e aparece no "Tocando agora" do painel e do player público, nos históricos e na biblioteca; no celular também na tela de bloqueio (Media Session). Link público: `/api/public/stations/<slug>/cover/<id>`. Músicas sem capa embutida mostram um ícone.
- **Icecast:** está instalado na imagem Docker (`icecast2`); `GET /api/health` mostra `engineMode: liquidsoap` quando Icecast + Liquidsoap estão em uso.

**Capa da rádio:** em Configurações → Capa da rádio (só admin) envie um logo (PNG/JPG/WEBP/GIF, até 4 MB; o tipo é conferido pelo conteúdo do arquivo). Ela entra **no lugar da capa das músicas que não têm** ("Tocando agora" do painel e do player, históricos, tela de bloqueio do celular), aparece no player quando nada está tocando e na lista de estações.

## Ouvintes em tempo real

Aba **Ouvintes** (e o cartão "Ouvintes agora" do painel): lista quem está conectado **agora**, com **IP, país (bandeira), aparelho (celular/computador/TV… + sistema), player (Chrome, VLC, app…), stream e há quanto tempo**, atualizando a cada 5 s. A contagem do painel e do player público vem da mesma fonte: cada conexão aberta no Icecast (`/admin/listclients`), no lugar do total do `status-json`. Os IPs aparecem só ao vivo e **não são guardados** (os relatórios continuam só com identificador anônimo + país). A localização é só o **país** (a base GeoLite2-Country não tem cidade). Atrás do Cloudflare o IP vem de `CF-Connecting-IP`. **Ainda não validado contra um Icecast real**: se a lista vier vazia com gente ouvindo, a causa provável é o `listclients` ou o IP repassado pelo `X-Forwarded-For`; o total então cai no valor do `status-json`.
