// Grava BUILD_INFO.json (commit e hora do build) para o painel mostrar a versão em uso.
// Lê o commit direto de .git (o git não precisa estar instalado); sem .git, fica sem commit.
import fs from 'node:fs';
import path from 'node:path';

function commit() {
  try {
    const head = fs.readFileSync('.git/HEAD', 'utf8').trim();
    if (!head.startsWith('ref:')) return head;
    const ref = head.slice(5).trim();
    const file = path.join('.git', ref);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    const line = fs.readFileSync('.git/packed-refs', 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.split(' ')[0] : null;
  } catch {
    return null;
  }
}

fs.writeFileSync('BUILD_INFO.json', JSON.stringify({ sha: commit(), builtAt: new Date().toISOString() }));
