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

## Estado atual

| Área | Situação |
|---|---|
| Login, primeiro setup, papéis admin/operador | Pronto, testado localmente |
| CRUD de estações, usuários, playlists, biblioteca (upload + tags) | Pronto, testado localmente |
| Playlists agendadas por dia da semana e horário (prioridade sobre a rotação geral) | Pronto na API/painel; o script Liquidsoap gerado foi revisado, mas **não executado** |
| Crossfade, normalização de volume (ReplayGain) e até 4 streams extras com formato/bitrate próprios | Pronto na API/painel/player; script Liquidsoap revisado, **não executado** |
| DJs com usuário/senha próprios (o usuário `source` continua valendo) e gravação das transmissões ao vivo, com download | Pronto na API/painel, testado; autenticação do harbor e `output.file` no Liquidsoap **não executados** |
| Player público, histórico, pedidos de músicas | Pronto (API testada; pedidos dependem do Liquidsoap) |
| Geração de `icecast.xml` e `radio.liq`, supervisor de processos | Escrito, **ainda não executado contra Icecast/Liquidsoap reais** |
| Imagem Docker | Escrita, **ainda não construída** |

Próximo passo imediato: subir em um servidor Linux, rodar `docker compose up --build`, criar uma estação e ajustar o que o Liquidsoap reclamar nos logs (`DATA_DIR/stations/<id>/logs/`). A sintaxe do script depende da versão do Liquidsoap fixada no `Dockerfile`.

## Roadmap (comparado ao AzuraCast)

1. **Validar o motor de streaming** no Linux (item acima).
2. ~~Playlists agendadas por dia/hora~~ (feito). Falta o tipo "uma vez por hora / a cada X músicas".
3. ~~Crossfade, normalização de volume (ReplayGain), vários mountpoints/bitrates por estação~~ (feito).
4. ~~DJs com conta própria, gravação de transmissões ao vivo~~ (feito). Falta mostrar quem é o DJ no ar e agendar horários de DJ.
5. Relatórios de ouvintes (por país, player, tempo) e gráficos.
6. Webhooks e integrações (Discord, redes sociais), API com chaves de acesso.
7. Podcasts, backups agendados, atualização pelo painel.
8. Relay/transmissão para outros serviços, HTTPS automático (Caddy) e multi-idioma.
9. Migrar SQLite para Postgres se o volume pedir.
