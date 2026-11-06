import type { StationRow } from '../db.js';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Gera o icecast.xml de uma estação (uma instância de Icecast por estação). */
export function buildIcecastConfig(st: StationRow, logDir: string): string {
  return `<icecast>
  <location>RadioForge</location>
  <admin>admin@localhost</admin>
  <limits>
    <clients>1000</clients>
    <sources>4</sources>
    <queue-size>524288</queue-size>
    <client-timeout>30</client-timeout>
    <header-timeout>15</header-timeout>
    <source-timeout>10</source-timeout>
  </limits>
  <authentication>
    <source-password>${esc(st.source_password)}</source-password>
    <relay-password>${esc(st.admin_password)}</relay-password>
    <admin-user>admin</admin-user>
    <admin-password>${esc(st.admin_password)}</admin-password>
  </authentication>
  <hostname>localhost</hostname>
  <listen-socket>
    <port>${st.stream_port}</port>
    <bind-address>0.0.0.0</bind-address>
  </listen-socket>
  <http-headers>
    <header name="Access-Control-Allow-Origin" value="*" />
  </http-headers>
  <fileserve>1</fileserve>
  <paths>
    <basedir>/usr/share/icecast2</basedir>
    <logdir>${esc(logDir)}</logdir>
    <webroot>/usr/share/icecast2/web</webroot>
    <adminroot>/usr/share/icecast2/admin</adminroot>
    <alias source="/" dest="/status.xsl"/>
  </paths>
  <logging>
    <accesslog>access.log</accesslog>
    <errorlog>error.log</errorlog>
    <loglevel>3</loglevel>
    <logsize>10000</logsize>
  </logging>
  <security>
    <chroot>0</chroot>
  </security>
</icecast>
`;
}
