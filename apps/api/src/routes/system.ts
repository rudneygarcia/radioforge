import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { authenticate, HttpError, requireAdmin } from '../auth.js';
import { engineMode } from '../engine/manager.js';

const REPO = process.env.UPDATE_REPO ?? 'rudneygarcia/radioforge';
const BRANCH = process.env.UPDATE_BRANCH ?? 'main';
const GITHUB_TOKEN = process.env.UPDATE_GITHUB_TOKEN ?? '';
const UPDATE_WEBHOOK_URL = process.env.UPDATE_WEBHOOK_URL ?? '';

function readJson<T>(url: URL | string): T | null {
  try {
    return JSON.parse(fs.readFileSync(url, 'utf8')) as T;
  } catch {
    return null;
  }
}

const pkg = readJson<{ version?: string }>(new URL('../../package.json', import.meta.url));
// Gerado no build do Docker (scripts/build-info.mjs); em desenvolvimento não existe.
const build = readJson<{ sha: string | null; builtAt: string }>('BUILD_INFO.json');

interface Latest {
  sha: string;
  message: string;
  date: string;
  author: string;
}

async function fetchLatest(): Promise<Latest> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'RadioForge-update-check',
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    throw new HttpError(
      424,
      GITHUB_TOKEN
        ? `O GitHub recusou a consulta (${res.status}). Confira UPDATE_REPO e se o token UPDATE_GITHUB_TOKEN tem acesso de leitura ao repositório.`
        : `O GitHub não devolveu o repositório ${REPO} (${res.status}). Se ele for privado, defina UPDATE_GITHUB_TOKEN (token só de leitura).`,
    );
  }
  if (!res.ok) throw new HttpError(424, `Erro ao consultar o GitHub (${res.status})`);
  const j = (await res.json()) as { sha: string; commit: { message: string; author?: { name?: string; date?: string }; committer?: { date?: string } } };
  return {
    sha: j.sha,
    message: j.commit.message.split('\n')[0],
    date: j.commit.committer?.date ?? j.commit.author?.date ?? '',
    author: j.commit.author?.name ?? '',
  };
}

/** Informações do sistema, verificação de versão nova e (opcional) disparo de atualização. Só admin logado. */
export async function systemRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', async (req) => requireAdmin(req));
  app.addHook('preHandler', async (req) => {
    if (req.viaApiKey) throw new HttpError(403, 'Use o painel (com login).');
  });

  app.get('/api/system', async () => ({
    version: pkg?.version ?? '?',
    commit: build?.sha ?? null,
    builtAt: build?.builtAt ?? null,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    node: process.version,
    engine: engineMode(),
    repo: REPO,
    branch: BRANCH,
    canUpdate: !!UPDATE_WEBHOOK_URL,
  }));

  app.post('/api/system/check', async () => {
    const latest = await fetchLatest();
    // Com o commit do build, a comparação é exata; sem ele, usa a data (build depois do commit = em dia).
    const upToDate = build?.sha ? build.sha === latest.sha : build?.builtAt ? Date.parse(build.builtAt) >= Date.parse(latest.date) : null;
    return { latest, upToDate };
  });

  app.post('/api/system/update', async () => {
    if (!UPDATE_WEBHOOK_URL) {
      throw new HttpError(400, 'Atualização automática não configurada. Defina UPDATE_WEBHOOK_URL (URL de redeploy) ou atualize pelo seu painel de deploy (o push no GitHub já dispara o deploy no Velix).');
    }
    let res: Response;
    try {
      // URL definida pelo administrador do servidor (variável de ambiente), não por usuários do painel.
      res = await fetch(UPDATE_WEBHOOK_URL, { method: 'POST', signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new HttpError(424, `Não foi possível chamar o webhook de atualização: ${(e as Error).message}`);
    }
    if (!res.ok) throw new HttpError(424, `O webhook de atualização respondeu ${res.status}`);
    return { ok: true, message: 'Atualização solicitada. A API reinicia sozinha quando o deploy terminar.' };
  });
}
