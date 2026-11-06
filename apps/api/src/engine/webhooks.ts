import crypto from 'node:crypto';
import { all, get, run, type StationRow, type WebhookRow } from '../db.js';
import { assertPublicUrl } from '../ssrf.js';

export const EVENTS = ['song_change', 'station_start', 'station_stop'] as const;
export type WebhookEvent = (typeof EVENTS)[number];

const EVENT_LABEL: Record<WebhookEvent, string> = {
  song_change: 'Tocando agora',
  station_start: 'Estação iniciada',
  station_stop: 'Estação parada',
};

function discordBody(st: StationRow, event: WebhookEvent, data: Record<string, unknown>) {
  const embed: Record<string, unknown> = {
    title: EVENT_LABEL[event],
    color: 0x2a78d6,
    footer: { text: st.name },
    timestamp: new Date().toISOString(),
  };
  if (event === 'song_change') {
    const artist = String(data.artist ?? '');
    embed.description = `**${String(data.title ?? '')}**${artist ? `\n${artist}` : ''}`;
  } else {
    embed.description = st.name;
  }
  return { username: st.name.slice(0, 80), embeds: [embed] };
}

/** Envia um webhook e registra o resultado. Nunca lança: falha de um destino não pode afetar a rádio. */
export async function deliver(hook: WebhookRow, st: StationRow, event: WebhookEvent, data: Record<string, unknown>) {
  let status = '';
  try {
    const url = await assertPublicUrl(hook.url);
    const payload =
      hook.type === 'discord'
        ? discordBody(st, event, data)
        : { event, station: { id: st.id, name: st.name, slug: st.slug }, data, timestamp: new Date().toISOString() };
    const body = JSON.stringify(payload);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'RadioForge/0.1',
        'X-RadioForge-Event': event,
        // Quem recebe confere a autenticidade recalculando o HMAC do corpo com o segredo do webhook.
        'X-RadioForge-Signature': `sha256=${crypto.createHmac('sha256', hook.secret).update(body).digest('hex')}`,
      },
      body,
      redirect: 'manual', // não segue redirecionamentos (poderiam levar a um endereço interno)
      signal: AbortSignal.timeout(5000),
    });
    status = res.ok ? `ok ${res.status}` : `erro ${res.status}`;
  } catch (e) {
    status = `falha: ${(e as Error).message}`.slice(0, 200);
  }
  run("UPDATE station_webhooks SET last_status = ?, last_at = datetime('now') WHERE id = ?", status, hook.id);
  return status;
}

/** Dispara, sem esperar, todos os webhooks ativos da estação que assinam este evento. */
export function dispatch(stationId: number, event: WebhookEvent, data: Record<string, unknown>) {
  const st = get<StationRow>('SELECT * FROM stations WHERE id = ?', stationId);
  if (!st) return;
  const hooks = all<WebhookRow>('SELECT * FROM station_webhooks WHERE station_id = ? AND enabled = 1', stationId);
  for (const h of hooks) {
    if (!h.events.split(',').includes(event)) continue;
    void deliver(h, st, event, data);
  }
}
