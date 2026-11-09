import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, stationFor } from '../auth.js';
import { all, get } from '../db.js';

const query = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  // Minutos de diferença do fuso do navegador para UTC (Date.getTimezoneOffset), para o gráfico por hora do dia.
  tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
  format: z.enum(['json', 'csv']).default('json'),
});

/** Escapa um campo CSV e neutraliza fórmulas (=, +, -, @) que planilhas executariam ao abrir o arquivo. */
function csvField(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cols: (string | number)[]) => cols.map(csvField).join(',');

export async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/stations/:id/reports', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const st = stationFor(req, id);
    const { days, tzOffset, format } = query.parse(req.query);
    const since = `-${days} days`;

    const totals = get<{ sessions: number; unique_listeners: number; seconds: number | null }>(
      `SELECT COUNT(*) AS sessions, COUNT(DISTINCT ip_hash) AS unique_listeners, SUM(duration) AS seconds
       FROM listener_sessions WHERE station_id = ? AND started_at >= datetime('now', ?)`,
      st.id,
      since,
    )!;
    const peak = get<{ peak: number | null }>(
      `SELECT MAX(listeners) AS peak FROM listener_samples WHERE station_id = ? AND at >= datetime('now', ?)`,
      st.id,
      since,
    );

    // Até 7 dias: ponto por hora; acima disso: ponto por dia.
    const bucket = days <= 7 ? '%Y-%m-%d %H:00' : '%Y-%m-%d';
    const timeline = all<{ t: string; avg: number; max: number }>(
      `SELECT strftime(?, at) AS t, ROUND(AVG(listeners), 1) AS avg, MAX(listeners) AS max
       FROM listener_samples WHERE station_id = ? AND at >= datetime('now', ?)
       GROUP BY t ORDER BY t`,
      bucket,
      st.id,
      since,
    );

    const group = (col: 'country' | 'player') =>
      all<{ name: string; sessions: number; listeners: number }>(
        `SELECT ${col} AS name, COUNT(*) AS sessions, COUNT(DISTINCT ip_hash) AS listeners
         FROM listener_sessions WHERE station_id = ? AND started_at >= datetime('now', ?)
         GROUP BY ${col} ORDER BY sessions DESC LIMIT 10`,
        st.id,
        since,
      );

    // Sessões por hora do dia no fuso do usuário (0–23).
    const byHour = all<{ h: string; sessions: number }>(
      `SELECT strftime('%H', started_at, ?) AS h, COUNT(*) AS sessions
       FROM listener_sessions WHERE station_id = ? AND started_at >= datetime('now', ?)
       GROUP BY h`,
      `${-tzOffset} minutes`,
      st.id,
      since,
    );
    const hours = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      sessions: byHour.find((r) => Number(r.h) === h)?.sessions ?? 0,
    }));

    const seconds = totals.seconds ?? 0;
    const report = {
      days,
      bucket: days <= 7 ? 'hour' : 'day',
      summary: {
        sessions: totals.sessions,
        uniqueListeners: totals.unique_listeners,
        listeningHours: Math.round((seconds / 3600) * 10) / 10,
        avgSessionMinutes: totals.sessions ? Math.round(seconds / totals.sessions / 60) : 0,
        peakListeners: peak?.peak ?? 0,
      },
      timeline,
      countries: group('country'),
      players: group('player'),
      hours,
    };
    if (format === 'json') return report;

    // CSV com seções separadas por linha em branco; UTF-8 com BOM para o Excel acertar os acentos.
    const s = report.summary;
    const lines = [
      csvRow(['Resumo', `Últimos ${days} dia(s)`]),
      csvRow(['Ouvintes únicos', s.uniqueListeners]),
      csvRow(['Sessões', s.sessions]),
      csvRow(['Horas ouvidas', s.listeningHours]),
      csvRow(['Duração média da sessão (min)', s.avgSessionMinutes]),
      csvRow(['Pico de ouvintes', s.peakListeners]),
      '',
      csvRow([report.bucket === 'hour' ? 'Hora (UTC)' : 'Dia (UTC)', 'Média de ouvintes', 'Pico']),
      ...timeline.map((r) => csvRow([r.t, r.avg, r.max])),
      '',
      csvRow(['País', 'Sessões', 'Ouvintes únicos']),
      ...report.countries.map((r) => csvRow([r.name, r.sessions, r.listeners])),
      '',
      csvRow(['Player', 'Sessões', 'Ouvintes únicos']),
      ...report.players.map((r) => csvRow([r.name, r.sessions, r.listeners])),
      '',
      csvRow(['Hora do dia', 'Sessões']),
      ...hours.map((r) => csvRow([`${String(r.hour).padStart(2, '0')}h`, r.sessions])),
    ];
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="relatorio-${st.slug}-${days}d.csv"`)
      .send('﻿' + lines.join('\r\n') + '\r\n');
  });
}
