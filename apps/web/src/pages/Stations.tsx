import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type Station } from '../api';
import { useAuth } from '../auth';
import { DiskSelect, useDisks } from '../DiskSelect';
import { Cover, Empty, Icon, Modal, PageHeader, useUi } from '../ui';

export default function Stations() {
  const { user } = useAuth();
  const { toast } = useUi();
  const [stations, setStations] = useState<Station[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mount, setMount] = useState('radio.mp3');
  // Endereço curto (URL): acompanha o nome enquanto a pessoa não mexer nele.
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [port, setPort] = useState('');
  const [secret, setSecret] = useState('');
  const [autodj, setAutodj] = useState(true);
  const [disk, setDisk] = useState('');
  const disks = useDisks();
  const genSecret = () => setSecret(Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join(''));
  const toSlug = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | 'on' | 'off'>('all');

  const load = () => api<Station[]>('/api/stations').then(setStations);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 10000);
    return () => clearInterval(t);
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/stations', { method: 'POST', body: { name, description, mount, slug: slug.replace(/-+$/, '') || undefined, port: port.trim() ? Number(port) : undefined, sourcePassword: secret.trim() || undefined, autodj, disk } });
      setOpen(false);
      setName('');
      setDescription('');
      setMount('radio.mp3');
      setSlug('');
      setSlugEdited(false);
      setPort('');
      setSecret('');
      setAutodj(true);
      setDisk('');
      toast('Estação criada');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isAdmin = user?.role === 'admin';
  const visible = (stations ?? []).filter((x) => (only === 'all' || (only === 'on') === x.running) && x.name.toLowerCase().includes(q.trim().toLowerCase()));
  const newButton = (
    <button onClick={() => setOpen(true)}>
      <Icon name="plus" /> Nova estação
    </button>
  );

  return (
    <>
      <PageHeader title="Estações" subtitle="Suas rádios no ar e o que está tocando agora." actions={isAdmin ? newButton : undefined} />

      {stations && stations.length > 0 && (
        <div className="stat-grid dash-stats">
          <div className="card dstat"><span className="dstat-ico"><Icon name="radio" size={20} /></span><div><div className="stat-label">Rádios</div><p className="big">{stations.length}</p></div></div>
          <div className="card dstat ok"><span className="dstat-ico"><Icon name="play" size={20} /></span><div><div className="stat-label">No ar agora</div><p className="big">{stations.filter((x) => x.running).length}<span className="muted" style={{ fontSize: 16 }}> / {stations.length}</span></p></div></div>
          <div className="card dstat violet"><span className="dstat-ico"><Icon name="users" size={20} /></span><div><div className="stat-label">Ouvintes agora</div><p className="big">{stations.reduce((n, x) => n + x.listeners, 0)}</p></div></div>
        </div>
      )}

      {stations && stations.length > 4 && (
        <div className="dash-toolbar">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar estação…" />
          <div className="seg">
            {([['all', 'Todas'], ['on', 'No ar'], ['off', 'Paradas']] as const).map(([k, l]) => (
              <button key={k} type="button" className={only === k ? 'active' : ''} onClick={() => setOnly(k)}>{l}</button>
            ))}
          </div>
        </div>
      )}

      {stations === null && (
        <div className="sgrid">
          {[0, 1, 2].map((i) => <div key={i} className="card skeleton" style={{ height: 230 }} />)}
        </div>
      )}

      {stations && stations.length === 0 && (
        <div className="card">
          <Empty
            icon="radio"
            title="Nenhuma estação ainda"
            text={isAdmin ? 'Crie sua primeira rádio para enviar músicas, montar playlists e ir ao ar.' : 'Peça a um administrador para dar acesso a uma estação.'}
            action={isAdmin ? newButton : undefined}
          />
        </div>
      )}

      {stations && stations.length > 0 && visible.length === 0 && (
        <div className="card"><Empty icon="radio" title="Nenhuma estação encontrada" text="Ajuste a busca ou o filtro." /></div>
      )}

      {stations && stations.length > 0 && (
        <div className="sgrid">
          {visible.map((s) => (
            <article key={s.id} className={`scard ${s.running ? 'live' : ''}`}>
              <Link to={`/stations/${s.id}`} className="scard-link">
                <div className="scard-banner" style={s.coverUrl ? { backgroundImage: `linear-gradient(180deg, rgba(15,23,42,.35), rgba(15,23,42,.7)), url(${s.coverUrl})` } : undefined}>
                  <span className={`badge ${s.running ? 'on' : 'off'}`}>{s.running ? 'no ar' : 'parada'}</span>
                  {s.live && <span className="tag accent" style={{ marginLeft: 6 }}><Icon name="mic" size={12} /> ao vivo</span>}
                  <span className="scard-pill"><Icon name="users" size={12} /> {s.listeners}</span>
                </div>
                <div className="scard-body">
                  <div className="scard-logo"><Cover url={s.nowPlaying?.coverUrl ?? s.coverUrl} size={64} /></div>
                  <h3 className="ellipsis">{s.name}</h3>
                  <p className="muted small-text ellipsis scard-desc">{s.description || ' '}</p>
                  <div className="scard-np">
                    <span className={`eq ${s.running ? 'on' : ''}`} aria-hidden><i /><i /><i /><i /></span>
                    <div className="scard-np-txt">
                      <small>{s.live ? 'Ao vivo agora' : 'Tocando agora'}</small>
                      <span className="ellipsis">{s.live ? `${s.live.name} ao vivo` : s.nowPlaying ? `${s.nowPlaying.artist ? `${s.nowPlaying.artist} — ` : ''}${s.nowPlaying.title}` : 'Sem histórico ainda'}</span>
                    </div>
                  </div>
                  <div className="station-meta">
                    <span><Icon name="users" size={14} /> {s.listeners} {s.listeners === 1 ? 'ouvinte' : 'ouvintes'}</span>
                    {s.streams[0] && <span className="tag">{s.streams[0].format.toUpperCase()} {s.streams[0].bitrate}k</span>}
                  </div>
                </div>
              </Link>
              <footer className="scard-ft">
                <Link to={`/stations/${s.id}`} className="button small"><Icon name="radio" size={14} /> Abrir painel</Link>
                <a href={`/listen/${s.slug}`} target="_blank" rel="noreferrer" className="button ghost small"><Icon name="link" size={14} /> Player</a>
              </footer>
            </article>
          ))}
        </div>
      )}

      <Modal
        open={open}
        title="Nova estação"
        size="lg"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="ghost" type="button" onClick={() => setOpen(false)}>Cancelar</button>
            <button form="new-station" disabled={busy}>{busy ? 'Criando…' : 'Criar estação'}</button>
          </>
        }
      >
        <form id="new-station" className="fields form-grid" onSubmit={create}>
          <label className="field">
            <span>Nome</span>
            <input value={name} onChange={(e) => { setName(e.target.value); if (!slugEdited) setSlug(toSlug(e.target.value)); }} placeholder="Ex.: Rádio Garcia" required />
          </label>
          <label className="field">
            <span>Endereço curto <em className="hint">(URL)</em></span>
            <div className="input-prefix">
              <span>{location.host}/listen/</span>
              <input value={slug} onChange={(e) => { setSlugEdited(true); setSlug(toSlug(e.target.value)); }} placeholder="radio-garcia" maxLength={40} />
            </div>
            <small className="hint">Vira o link do player e do stream: {location.host}/listen/<strong>{slug.replace(/-+$/, '') || 'radio-garcia'}</strong>/{mount || 'radio.mp3'}. Só letras minúsculas, números e hífen. Dá para mudar depois em Editar estação.</small>
          </label>
          <label className="field">
            <span>Descrição <em className="hint">(opcional)</em></span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Uma frase sobre a programação" />
          </label>
          <label className="field">
            <span>Nome do stream</span>
            <input value={mount} onChange={(e) => setMount(e.target.value.replace(/[^a-zA-Z0-9._-]/g, ''))} placeholder="radio.mp3" maxLength={40} required />
            <small className="hint">É o final do endereço de escuta. Padrão: radio.mp3 — dá para mudar depois em Editar estação.</small>
          </label>
          <label className="field">
            <span>Porta da estação <em className="hint">(opcional)</em></span>
            <input type="number" min={1024} max={65000} value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} placeholder="Automática" />
            <small className="hint">Deixe em branco para o painel escolher uma porta livre. Se preencher, ela precisa estar liberada no servidor (a estação usa 10 portas seguidas a partir dela: o DJ ao vivo fica na porta +5).</small>
          </label>
          <label className="field">
            <span>Senha da transmissão ao vivo <em className="hint">(opcional)</em></span>
            <div className="row" style={{ margin: 0 }}>
              <input value={secret} onChange={(e) => setSecret(e.target.value.replace(/\s/g, ''))} placeholder="Automática" maxLength={64} autoComplete="off" style={{ flex: 1, minWidth: 160 }} />
              <button type="button" className="ghost small" onClick={genSecret}>Gerar</button>
            </div>
            <small className="hint">É a senha que o DJ usa no programa de transmissão (usuário <code>source</code>). Mínimo 6 caracteres, sem espaços. Em branco, o painel cria uma senha forte. Dá para trocar depois em Editar estação.</small>
          </label>
          {disks && disks.length > 1 && (
            <label className="field span-all">
              <span>Disco das músicas</span>
              <DiskSelect disks={disks} value={disk} onChange={setDisk} />
              <small className="hint">Em qual HD ficam as músicas que forem enviadas para a biblioteca (painel e SFTP). Dá para trocar depois em Editar estação; as músicas já enviadas não são movidas.</small>
            </label>
          )}
          <label className="check-line span-all">
            <input type="checkbox" checked={autodj} onChange={(e) => setAutodj(e.target.checked)} />
            <span>Usar AutoDJ (músicas automáticas)<small>Desmarque se o cliente só transmite ao vivo: a estação roda só com o Icecast (o DJ conecta direto nele) e todo o processamento de áudio e o Liquidsoap ficam desligados, economizando CPU. Dá para ligar o AutoDJ depois em Editar estação.</small></span>
          </label>
          {error && <p className="error span-all">{error}</p>}
        </form>
      </Modal>
    </>
  );
}
