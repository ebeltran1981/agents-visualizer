// pi: $PI_CODING_AGENT_DIR (default ~/.pi/agent)/sessions/--<cwd>--/<ISO>_<id>.jsonl. pi has no built-in subagents.
import os from 'node:os';
import path from 'node:path';
import { piHarness } from './pi-family.js';

const base = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');

export default piHarness({ id: 'pi', label: 'pi', bin: 'pi', home: base, root: path.join(base, 'sessions') });
