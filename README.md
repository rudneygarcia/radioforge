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

Force um modo com `ENGINE_MODE=native` ou `ENGINE_MODE=liquidsoap`. O painel avisa quando está no modo simples. O endereço do stream é `http://<PUBLIC_HOST>:<porta>/radio`; no Windows, libere o Node no firewall se ele perguntar.

## Estado atual

| Área | Situação |
|---|---|
| Login, primeiro setup, papéis admin/operador | Pronto, testado localmente |
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
2. ~~Playlists agendadas por dia/hora~~ (feito). Também há "intercalar 1 faixa a cada N músicas" (vinhetas/avisos; só no modo Liquidsoap, **script ainda não executado**). Falta o tipo "uma vez por hora".
3. ~~Crossfade, normalização de volume (ReplayGain), vários mountpoints/bitrates por estação~~ (feito).
4. ~~DJs com conta própria, gravação de transmissões ao vivo~~ (feito). O painel e o player público mostram quem está ao vivo (o Liquidsoap avisa a API ao conectar/desconectar; **não validado com um DJ real ainda**). Falta agendar horários de DJ.
5. ~~Relatórios de ouvintes (por país, player, tempo) e gráficos~~ (feito, com exportação CSV: botão no painel ou `GET /api/stations/:id/reports?days=7&format=csv`). Os cartões comparam com o período anterior de mesma duração (▲/▼ %), também no CSV e em `previous` no JSON.
6. ~~Webhooks e integrações (Discord), API com chaves de acesso~~ (feito, chaves podem ser **somente leitura**: só GET/HEAD). Falta integração com redes sociais e documentação OpenAPI.
7. ~~Backups agendados~~ (feito: menu **Backups**, só admin; cópia diária do banco, guarda as 7 últimas, download pelo painel; **não inclui músicas/gravações**, copie o volume `/data` para elas). Falta: podcasts, restaurar pelo painel, atualização pelo painel.
8. Relay/transmissão para outros serviços, HTTPS automático (Caddy) e multi-idioma.
9. Migrar SQLite para Postgres se o volume pedir.
