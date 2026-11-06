import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, stationFor } from '../auth.js';
import { all, get } from '../db.js';

const query = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  // Minutos de diferença do fuso do navegador para UTC (Date.getTimezoneOffset), para o gráfico por hora do dia.
  tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
});

export async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/stations/:id/reports', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const st = stationFor(req, id);
    const { days, tzOffset } = query.parse(req.query);
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
    return {
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
  });
}
