// oh-my-pi: ~/.omp/agent/sessions/<encoded cwd>/<ISO>_<id>.jsonl. Each session has a same-named sidecar folder
// where the task tool writes one <Name>.jsonl per subagent (nested subagents get their own sidecar), and
// where the advisor, when enabled, writes __advisor.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { piHarness } from './pi-family.js';

function subagentsOf(key) {
  const out = [];
  const walk = (dir, prefix, depth) => {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const f of files.filter(f => f.endsWith('.jsonl'))) {
      const stem = f.slice(0, -6), id = prefix + stem;
      out.push({ id, file: path.join(dir, f), meta: { agentType: stem.startsWith('__advisor') ? 'advisor' : 'task', description: stem } });
      if (depth < 3) walk(path.join(dir, stem), id + '/', depth + 1);
    }
  };
  walk(key.slice(0, -6), '', 0);
  return out;
}

export default piHarness({ id: 'omp', label: 'oh-my-pi', bin: 'omp', root: path.join(os.homedir(), '.omp', 'agent', 'sessions'), subagentsOf });
