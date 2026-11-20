import type { DjRow, MountRow, StationRow } from '../db.js';
import { config } from '../config.js';
import { getLicenseKey, presetPath, stereoLibPath } from './stereotool.js';
import { icePort } from './ports.js';
import { CUE_KEYS } from './cuecache.js';

/** Literal de string seguro para Liquidsoap (JSON é compatível com as escapes dele). */
const q = (s: string) => JSON.stringify(s);

export interface LiqPlaylist {
  id: number;
  mode: 'shuffle' | 'sequential';
  weight: number;
  /** > 0: toca 1 faixa desta playlist a cada N faixas da rotação normal (vinhetas/avisos). */
  everySongs: number;
  /** Vinheta: as faixas vão ao ar sem enviar o nome do arquivo ao servidor. */
  jingle?: boolean;
  /** Playlist padrão: é a rotação base. As demais só entram por regra (a cada N músicas, horário ou tempo). */
  isDefault?: boolean;
  m3uPath: string;
  /** Se presente, a playlist só toca na janela indicada e tem prioridade sobre a rotação geral. */
  schedule?: { days: number[]; start: string; end: string };
}

/** "08:30" -> "8h30m" (formato dos predicados de tempo do Liquidsoap). */
const liqTime = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h}h${String(m).padStart(2, '0')}m`;
};

/** Predicado Liquidsoap, ex.: `{ (1w or 3w) and 8h00m-10h00m }`. */
export function schedulePredicate(s: NonNullable<LiqPlaylist['schedule']>): string {
  const parts: string[] = [];
  if (s.days.length > 0 && s.days.length < 7) parts.push(`(${s.days.map((d) => `${d}w`).join(' or ')})`);
  parts.push(`${liqTime(s.start)}-${liqTime(s.end)}`);
  return `{ ${parts.join(' and ')} }`;
}

/** Mesmo horário (dias + início + fim) = mesma chave: usado para casar uma vinheta agendada com a playlist que toca na mesma janela. */
export const scheduleKey = (s: NonNullable<LiqPlaylist['schedule']>) => JSON.stringify({ days: [...s.days].sort((a, b) => a - b), start: s.start, end: s.end });

/**
 * Chamada do plugin LADSPA `master_me` (https://github.com/trummerschlunk/master_me), o mesmo processador de volume
 * que o AzuraCast usa. Precisa do arquivo `master_me-ladspa.so` instalado na imagem (Dockerfile). Os valores abaixo
 * são os mesmos do preset padrão do AzuraCast ("Music General"), testados por muita gente: leveler + compressor +
 * multibanda + limitador num só plugin — por isso, ao contrário do processador interno, ele entra SOZINHO (sem o
 * normalizador/compressor/limitador do painel). `gainDb` (Volume extra) vira o ganho de entrada do próprio plugin.
 */
function masterMeChain(gainDb: number, targetLufs: number, variant: 0 | 1): string[] {
  if (variant === 1) return [`radio = ladspa.master_me(radio)`]; // só os valores padrão do próprio plugin
  return [
    `radio = ladspa.master_me(`,
    `  bypass = false, brickwall_bypass = false, eq_bypass = false, gate_bypass = true,`,
    `  kneecomp_bypass = false, leveler_bypass = false, limiter_bypass = false, mscomp_bypass = false,`,
    `  target = ${Math.round(targetLufs)}, brickwall_ceiling = -1.00, brickwall_release = 75.00,`,
    `  eq_highpass_freq = 5.00, eq_side_bandwidth = 1.00, eq_side_freq = 600.00, eq_side_gain = 1.00, eq_tilt_gain = 0.00,`,
    `  gate_attack = 0.00, gate_hold = 50.00, gate_release = 430.50, gate_threshold = -90.00,`,
    `  kneecomp_attack = 20.00, kneecomp_dry_wet = 50, kneecomp_ff_fb = 50, kneecomp_knee = 6.00, kneecomp_link = 60,`,
    `  kneecomp_makeup = 0.00, kneecomp_release = 340.00, kneecomp_strength = 20, kneecomp_tar_thresh = -4.00,`,
    `  leveler_brake_threshold = -10.00, leveler_max = 10.00, leveler_max__ = 10.00, leveler_speed = 20,`,
    `  limiter_attack = 3.00, limiter_ff_fb = 50, limiter_knee = 3.00, limiter_makeup = 0.00, limiter_release = 40.00,`,
    `  limiter_strength = 80, limiter_tar_thresh = 6.00,`,
    `  high_attack = 8.00, high_crossover = 8000.00, high_knee = 12.00, high_link = 30, high_release = 30.00, high_strength = 30, high_tar_thresh = -12.00,`,
    `  low_attack = 15.00, low_crossover = 60.00, low_knee = 12.00, low_link = 70, low_release = 150.00, low_strength = 10, low_tar_thresh = -3.00,`,
    `  makeup = 1.00, dc_blocker = false, input_gain = ${gainDb.toFixed(2)},`,
    `  mono = false, phase_l = false, phase_r = false, stereo_correct = false,`,
    `  radio)`,
  ];
}

/**
 * Cadeia de processamento de áudio (estilo "rádio"): normalizador (nivela o volume entre faixas),
 * compressor (aproxima o baixo do alto), ganho extra opcional e LIMITADOR no fim, que impede o som de
 * estourar/distorcer mesmo com volume alto. Presets: balanced (padrão), loud (estilo FM) e master_me (plugin externo).
 *
 * `variant`: 0 = completa (com parâmetros); 1 = só valores padrão do Liquidsoap (se algum nome de
 * parâmetro não existir nesta versão); o manager tenta 0, depois 1, e por fim sem processamento.
 */
export function audioChain(preset: 'off' | 'balanced' | 'loud' | 'master_me', gainDb = 0, variant: 0 | 1 = 0, masterTarget = -14): string[] {
  if (preset === 'off' && gainDb <= 0) return [];
  if (preset === 'master_me') return masterMeChain(gainDb, masterTarget, variant);
  const out: string[] = [];
  const gain = gainDb > 0 ? [`radio = amplify(${Math.pow(10, gainDb / 20).toFixed(3)}, radio)`] : [];
  if (variant === 1) {
    if (preset !== 'off') out.push(`radio = normalize(radio)`, `radio = compress(radio)`);
    out.push(...gain, `radio = limit(radio)`);
    return out;
  }
  if (preset === 'balanced') {
    // `gain_min = 0` trava o normalizador para só AUMENTAR quem está fraco (nunca abaixar quem já está forte): com
    // música já masterizada perto do teto, antes ele reduzia para bater no alvo e o resto da cadeia não devolvia esse
    // volume. O compressor agora só toca perto do teto (-6 dB) e bem de leve, só para segurar picos isolados.
    out.push(
      `radio = normalize(target = -10., gain_min = 0., gain_max = 14., radio)`,
      `radio = compress(threshold = -6., ratio = 2., attack = 15., release = 150., gain = 1., radio)`,
    );
  } else if (preset === 'loud') {
    out.push(
      `radio = normalize(target = -8., gain_min = 0., gain_max = 16., radio)`,
      `radio = compress(threshold = -8., ratio = 2.5, attack = 10., release = 120., gain = 2., radio)`,
    );
  }
  // Limitador rápido (ataque/liberação curtos) e com proporção mais branda: só segura o pico que passar do teto,
  // sem ficar "preso" reduzindo o resto da música por perto demais do teto.
  out.push(...gain, `radio = limit(threshold = -1., attack = 5., release = 80., ratio = 6., radio)`);
  return out;
}

/**
 * Vinheta/aviso "a cada N músicas" com contagem própria (no lugar do `rotate`): conta as músicas que tocam e, quando chega a vez, a
 * vinheta entra. Quando um comercial começa a tocar, a contagem volta a zero: a vinheta que estava para entrar (colada no bloco) é
 * descartada e, depois do bloco, a programação volta direto à música: nada de vinheta antes da vinheta de saída de bloco nem depois
 * da de entrada. Devolve o nome da fonte resultante. `switch` pula fonte que não está pronta e só troca no fim da faixa.
 */
function insertGate(lines: string[], music: string, ins: string, every: number, tag: string): string {
  lines.push(
    `rf_ep_${tag} = ref(0)`,
    `rf_cnt_${tag} = ref(0)`,
    `def rf_sync_${tag}() =`,
    `  if rf_ep_${tag}() != rf_ad_epoch() then`,
    `    rf_ep_${tag} := rf_ad_epoch()`,
    `    rf_cnt_${tag} := 0`,
    `  end`,
    `end`,
    `def rf_music_${tag}(m) =`,
    `  ignore(m)`,
    `  rf_sync_${tag}()`,
    `  rf_cnt_${tag} := rf_cnt_${tag}() + 1`,
    `end`,
    `def rf_ins_${tag}(m) =`,
    `  ignore(m)`,
    `  rf_sync_${tag}()`,
    `  rf_cnt_${tag} := 0`,
    `end`,
    `def rf_due_${tag}() =`,
    `  rf_sync_${tag}()`,
    `  rf_cnt_${tag}() >= ${every}`,
    `end`,
    `${music}.on_metadata(rf_music_${tag})`,
    `${ins}.on_metadata(rf_ins_${tag})`,
    `rf_out_${tag} = switch(id = "ins_${tag}", track_sensitive = true, [(rf_due_${tag}, ${ins}), ({true}, ${music})])`,
  );
  return `rf_out_${tag}`;
}

export const harborPort = (st: StationRow) => st.stream_port + 5;
export const telnetPort = (st: StationRow) => st.stream_port + 6;

/**
 * Gera o script Liquidsoap da estação.
 * Prioridade de fontes: DJ ao vivo > pedidos de ouvintes > rotação das playlists > silêncio.
 */
export function buildLiquidsoapScript(
  st: StationRow,
  playlists: LiqPlaylist[],
  extraMounts: MountRow[] = [],
  djs: DjRow[] = [],
  opts: {
    /** 0 = processador de áudio completo, 1 = só valores padrão, 2 = sem processador. */
    audio?: 0 | 1 | 2;
    /** Mantém o AutoDJ tocando (mudo) durante o ao vivo, para continuar a mesma música quando o DJ cair. */
    keepAlive?: boolean;
    /** AutoCue: análise de cada faixa (cue in/out, fades) e crossfade inteligente nas passagens. */
    autocue?: boolean;
    /** Crossfade com os valores personalizados da estação (duração e fades); senão, o padrão do Liquidsoap. */
    tuned?: boolean;
    /** Stereo Tool no lugar do processador interno (precisa da biblioteca enviada). */
    stereo?: boolean;
    /** Próxima faixa escolhida pela API (request.dynamic) em vez das playlists .m3u. */
    dyn?: boolean;
    /** Guarda a análise do AutoCue de cada música (cache): só tentado primeiro; se o Liquidsoap recusar, sobe sem. */
    cue?: boolean;
    /** Também aceita encoders no mount "/" (padrão do AzuraCast) além de /live. */
    root?: boolean;
    /** Vinheta "a cada N músicas" com contagem própria, que um comercial começando zera (some a vinheta colada no bloco). */
    gate?: boolean;
  } = {},
): string {
  const lines: string[] = [];
  // Só vale se há alguma vinheta/aviso "a cada N músicas" para controlar.
  const gate = !!opts.gate && playlists.some((p) => p.everySongs > 0);
  lines.push(
    `settings.log.level := 3`,
    `settings.server.telnet := true`,
    `settings.server.telnet.bind_addr := "127.0.0.1"`,
    `settings.server.telnet.port := ${telnetPort(st)}`,
    // Encoder que para de mandar áudio (queda de internet) é dado como desconectado após este tempo e o AutoDJ volta.
    // A análise do AutoCue lê a música inteira; com várias faixas na fila ela passava dos 29 s padrão e o pedido era descartado
    // ("Time limit exceeded ... timeout: 29.00"). Prazos maiores evitam perder pedidos.
    `settings.request.timeout := 120.`,
    `settings.autocue.internal.timeout := 60.`,
    `settings.harbor.timeout := ${Math.max(3, Math.min(60, Math.round(st.live_timeout || 8)))}.`,
    ``,
    // AutoCue: guarda a análise de cada música (a primeira vez) para o painel reaproveitar e não analisar de novo.
    // Precisa ficar FORA de "notify" (uma def própria): dentro dela ficaria só visível ali e `radio.on_metadata(learn_cue)`,
    // chamado lá embaixo, não a encontraria ("Undefined variable learn_cue"), derrubando sempre essa tentativa.
    ...(opts.cue
      ? [
          `def learn_cue(m) =`,
          `  if m["liq_cue_in"] != "" and m["rf_cue"] == "" and m["rf_jingle"] != "1" then`,
          `    payload = json.stringify({filename = m["filename"], ${CUE_KEYS.map((k) => `${k} = m["${k}"]`).join(', ')}})`,
          `    thread.run({ignore(http.post(headers = [("Content-Type", "application/json"), ("X-Internal-Token", ${q(config.internalToken)})], data = payload, ${q(`${config.apiInternalUrl}/internal/stations/${st.id}/cue`)}))})`,
          `  end`,
          `end`,
          ``,
        ]
      : []),
    ...(gate ? [`# Quantos comerciais já começaram: cada um zera a contagem das vinhetas "a cada N" (ver rf_sync_*).`, `rf_ad_epoch = ref(0)`, ``] : []),
    `# Avisa a API de cada faixa tocada (histórico + now playing).`,
    `# Vinhetas vêm marcadas com rf_jingle (annotate no .m3u): não avisam o servidor.`,
    `def notify(m) =`,
    `  if m["rf_jingle"] != "1" then`,
    `    payload = json.stringify({artist = m["artist"], title = m["title"], filename = m["filename"]})`,
    `    thread.run({ignore(http.post(headers = [("Content-Type", "application/json"), ("X-Internal-Token", ${q(config.internalToken)})], data = payload, ${q(`${config.apiInternalUrl}/internal/stations/${st.id}/track`)}))})`,
    `  end`,
    // Comercial veiculado: o disparo marca a faixa com rf_ad (id do registro); ao começar a tocar, o painel confirma "tocou".
    `  if m["rf_ad"] != "" then`,
    ...(gate ? [`    rf_ad_epoch := rf_ad_epoch() + 1`] : []),
    `    ad_url = (${q(`${config.apiInternalUrl}/internal/stations/${st.id}/ad-played/`)} ^ m["rf_ad"])`,
    `    thread.run({ignore(http.post(headers = [("Content-Type", "application/json"), ("X-Internal-Token", ${q(config.internalToken)})], data = "{}", ad_url))})`,
    `  end`,
    `end`,
    ``,
  );

  // AutoCue: ao preparar cada faixa o Liquidsoap mede o início/fim reais (sem silêncio), a sobreposição e os fades.
  if (opts.autocue) lines.push(`enable_autocue_metadata()`, ``);

  const names: string[] = [];
  const weights: number[] = [];
  const scheduled: { key: string; pred: string; n: string }[] = [];
  // Vinhetas com o MESMO horário de uma playlist agendada: entram só dentro dela (ver mais abaixo), não na rotação comum.
  const scheduledInserts: { key: string; n: string; every: number }[] = [];
  const inserts: { n: string; every: number }[] = [];
  // Com playlist padrão, a rotação é SÓ ela; as outras entram por regra e, sem regra, não tocam (não se misturam).
  const hasDefault = playlists.some((p) => p.isDefault && !p.schedule);
  for (const p of playlists) {
    const n = `pl_${p.id}`;
    let role: 'scheduled' | 'scheduledInsert' | 'insert' | 'rotation' | 'skip';
    if (p.schedule && p.jingle && p.everySongs > 0) role = 'scheduledInsert';
    else if (p.schedule) role = 'scheduled';
    else if (hasDefault) role = p.isDefault ? 'rotation' : p.everySongs > 0 ? 'insert' : 'skip';
    else role = p.everySongs > 0 ? 'insert' : 'rotation';
    if (role === 'skip') continue;
    if (opts.dyn) {
      // O painel escolhe a faixa (regras de não repetir música/artista); o Liquidsoap só pergunta e toca.
      lines.push(
        `def next_${n}() =`,
        `  r = http.get(headers = [("X-Internal-Token", ${q(config.internalToken)})], timeout = 10., ${q(`${config.apiInternalUrl}/internal/stations/${st.id}/next/${p.id}`)})`,
        `  uri = string.trim("#{r}")`,
        `  if r.status_code == 200 and uri != "" then request.create(uri) else null() end`,
        `end`,
        `${n} = request.dynamic(id = ${q(n)}, retry_delay = 3., next_${n})`,
      );
    } else {
      lines.push(
        `${n} = playlist(id = ${q(n)}, mode = ${q(p.mode === 'shuffle' ? 'randomize' : 'normal')}, reload_mode = "watch", ${q(p.m3uPath)})`,
      );
    }
    if (role === 'scheduled') scheduled.push({ key: scheduleKey(p.schedule!), pred: schedulePredicate(p.schedule!), n });
    else if (role === 'scheduledInsert') scheduledInserts.push({ key: scheduleKey(p.schedule!), n, every: p.everySongs });
    else if (role === 'insert') inserts.push({ n, every: p.everySongs });
    else {
      names.push(n);
      weights.push(hasDefault ? 1 : Math.max(1, p.weight));
    }
  }
  // Playlists "a cada N" sem nenhuma playlist normal para intercalar viram rotação comum.
  if (names.length === 0 && inserts.length > 0) {
    for (const i of inserts) {
      names.push(i.n);
      weights.push(1);
    }
    inserts.length = 0;
  }

  if (names.length === 0) {
    lines.push(`rotation = blank(id = "no_playlists")`);
  } else {
    lines.push(`rotation = random(id = "rotation", weights = [${weights.join(', ')}], [${names.join(', ')}])`);
    // rotate com pesos [N, 1]: N faixas da rotação, depois 1 da playlist de inserção.
    for (const i of inserts) {
      if (gate) lines.push(`rotation = ${insertGate(lines, 'rotation', i.n, i.every, i.n)}`);
      else lines.push(`rotation = rotate(id = "ins_${i.n}", weights = [${i.every}, 1], [rotation, ${i.n}])`);
    }
  }

  lines.push(`requests = request.queue(id = "requests")`);
  // Playlists agendadas ficam indisponíveis fora da janela, então o fallback cai na rotação geral.
  const auto = ['requests'];
  // Cada playlist agendada entra sozinha na sua janela; se houver vinheta com o MESMO horário, ela entra "a cada N"
  // dentro dessa janela (no lugar das vinhetas comuns, que ficam fora porque a rotação toda fica fora também).
  const scheduledFinal = scheduled.map((s) => {
    let src = s.n;
    for (const ins of scheduledInserts.filter((i) => i.key === s.key)) {
      src = gate ? insertGate(lines, src, ins.n, ins.every, `${s.n}_${ins.n}`) : `rotate(id = "ins_${ins.n}", weights = [${ins.every}, 1], [${src}, ${ins.n}])`;
    }
    return `(${s.pred}, ${src})`;
  });
  if (scheduledFinal.length > 0) {
    lines.push(`scheduled = switch(id = "scheduled", track_sensitive = true, [${scheduledFinal.join(', ')}])`);
    auto.push('scheduled');
  }
  auto.push('rotation');
  lines.push(`radio = fallback(id = "auto", track_sensitive = true, [${auto.join(', ')}])`);
  if (opts.cue) lines.push(`radio.on_metadata(learn_cue)`);

  // Normalização e crossfade só no áudio automático: o DJ ao vivo entra depois, sem processamento.
  // Com o AutoCue ligado e o nivelamento dele (liq_amplify) ativo, o ReplayGain seria uma SEGUNDA análise de volume de cada faixa
  // (CPU a mais) e um segundo ganho em cima do primeiro: o AutoCue já nivela, então o ReplayGain só entra quando ele não faz isso.
  if (st.normalize && !(opts.autocue && st.autocue_level)) {
    lines.push(`enable_replaygain_metadata()`, `radio = amplify(1., override = "replaygain_track_gain", radio)`);
  }
  if (opts.autocue) {
    // Volume nivelado pelo AutoCue (liq_amplify) em tudo que entra aqui: músicas, vinhetas e hora certa.
    if (st.autocue_level) lines.push(`radio = amplify(1., override = "liq_amplify", radio)`);
    // Crossfade guiado pelos pontos do AutoCue (vale para músicas, vinhetas e avisos de hora: tudo passa por aqui).
    lines.push(
      opts.tuned
        ? `radio = crossfade(duration = ${st.autocue_duration.toFixed(2)}, fade_in = ${st.autocue_fade_in.toFixed(2)}, fade_out = ${st.autocue_fade_out.toFixed(2)}, radio)`
        : `radio = crossfade(radio)`,
    );
  } else if (st.crossfade_seconds > 0) {
    lines.push(`radio = crossfade(duration = ${st.crossfade_seconds.toFixed(1)}, radio)`);
  }

  if (st.live_enabled) {
    // Credenciais aceitas: o usuário "source" (senha da estação) + cada DJ ativo. DJ com horário
    // só autentica dentro da janela (o predicado de tempo é avaliado a cada tentativa de conexão).
    // Cada item: condição de login + o nome que aparece como DJ ao vivo.
    const clauses: { cond: string; user: string }[] = [{ cond: `(login.user == ${q('source')} and login.password == ${q(st.source_password)})`, user: 'source' }];
    for (const d of djs.filter((x) => x.enabled)) {
      let window = '';
      if (d.schedule_enabled) {
        const win = `dj_window_${d.id}`;
        lines.push(
          `${win} = ${schedulePredicate({ days: d.days.split(',').filter(Boolean).map(Number), start: d.start_time, end: d.end_time })}`,
        );
        window = ` and ${win}()`;
      }
      clauses.push({ cond: `(login.user == ${q(d.username)} and login.password == ${q(d.password)}${window})`, user: d.username });
      // Formato do AzuraCast/Shoutcast: o encoder manda a senha como "usuario:senha" (com qualquer usuário no login).
      clauses.push({ cond: `(login.password == ${q(`${d.username}:${d.password}`)}${window})`, user: d.username });
    }
    lines.push(
      // Guarda quem autenticou por último para avisar a API quem entrou no ar.
      `dj_user = ref("")`,
      `def dj_auth(login) =`,
      // Com `root` (compatível com o AzuraCast) aceita também a senha no formato "usuario:senha"; sem ele, só login + senha.
      ...(opts.root
        ? [...clauses.flatMap((c, i) => [`  ${i === 0 ? 'if' : 'elsif'} ${c.cond} then`, `    dj_user := ${q(c.user)}`, `    true`]), `  else`, `    false`, `  end`]
        : [`  ok = ${clauses.filter((_, i) => i === 0 || i % 2 === 1).map((c) => c.cond).join(' or ')}`, `  if ok then dj_user := login.user end`, `  ok`]),
      `end`,
      `def notify_live(event) =`,
      `  payload = json.stringify({event = event, user = dj_user()})`,
      `  thread.run({ignore(http.post(headers = [("Content-Type", "application/json"), ("X-Internal-Token", ${q(config.internalToken)})], data = payload, ${q(`${config.apiInternalUrl}/internal/stations/${st.id}/live`)}))})`,
      `end`,
      `live = input.harbor("live", port = ${harborPort(st)}, auth = dj_auth, on_connect = fun (_) -> notify_live("connect"), on_disconnect = fun () -> notify_live("disconnect"))`,
    );
    if (opts.root) {
      // Encoders do AzuraCast usam o mount "/" na porta do DJ: aceita os dois (cada um é uma fonte; vale quem estiver conectado).
      lines.push(
        `live_root = input.harbor("/", port = ${harborPort(st)}, auth = dj_auth, on_connect = fun (_) -> notify_live("connect"), on_disconnect = fun () -> notify_live("disconnect"))`,
        `live = fallback(id = "live_inputs", track_sensitive = false, [live, live_root])`,
      );
    }
    // O AutoDJ continua sendo "puxado" por uma saída muda enquanto o DJ está no ar: quando o encoder cai, a música
    // que estiver tocando segue de onde está (em vez de o AutoDJ recomeçar numa faixa nova).
    if (opts.keepAlive) lines.push(`output.dummy(id = "autodj_background", fallible = true, radio)`);
    lines.push(`radio = fallback(id = "dj", track_sensitive = false, [live, radio])`);
  }

  // Processador de áudio: sobre tudo que vai ao ar (músicas e DJ). Sem a opção, o áudio sai como veio.
  const audioVariant = opts.audio ?? 0;
  if (opts.stereo) {
    // Stereo Tool: biblioteca do servidor + preset (.sts) da estação + licença. Substitui o processador interno.
    const args = [`library_file = ${q(stereoLibPath())}`];
    const licenseKey = getLicenseKey(); // chave única do servidor
    if (licenseKey) args.push(`license_key = ${q(licenseKey)}`);
    if (st.stereo_preset) args.push(`preset = ${q(presetPath(st.id, st.stereo_preset))}`);
    lines.push(`radio = stereotool(${args.join(', ')}, radio)`);
  } else if (audioVariant === 0 || audioVariant === 1) lines.push(...audioChain(st.audio_preset, st.audio_gain, audioVariant, st.audio_master_target));

  lines.push(`radio = mksafe(radio)`, `radio.on_metadata(notify)`, ``);

  const encoder = (format: string, bitrate: number) =>
    format === 'ogg'
      ? `%ogg(%vorbis.abr(bitrate = ${bitrate}))`
      : format === 'aac'
        ? `%ffmpeg(format = "adts", %audio(codec = "aac", b = "${bitrate}k"))` // AAC-LC pelo FFmpeg embutido do Liquidsoap
        : `%mp3(bitrate = ${bitrate})`;

  // Um output por mountpoint, todos alimentados pela mesma fonte.
  const outputs = [{ mount: st.mount, format: st.format, bitrate: st.bitrate }, ...extraMounts];
  for (const o of outputs) {
    lines.push(
      `output.icecast(${encoder(o.format, o.bitrate)},`,
      ...(o.format === 'aac' ? ['  format = "audio/aac",'] : []),
      `  host = "127.0.0.1", port = ${icePort(st)}, password = ${q(st.source_password)},`,
      `  mount = ${q(o.mount)}, name = ${q(st.name)}, description = ${q(st.description)},`,
      `  radio)`,
      ``,
    );
  }
  return lines.join('\n');
}
