// Electron shell: runs the dashboard server in-process and shows it in a native window.
import { app, BrowserWindow, shell, nativeImage, screen } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

if (!app.requestSingleInstanceLock()) app.exit();

const icon = nativeImage.createFromPath(path.join(import.meta.dirname, 'icon.png'));
const STATE = path.join(app.getPath('userData'), 'window.json');
let win;

// Apps opened from Finder or a desktop launcher get a bare PATH; take the login shell's so harness CLIs are found.
function loginShellPath() {
  if (process.platform === 'win32') return;
  try {
    const out = execFileSync(process.env.SHELL || '/bin/sh', ['-ilc', 'printf "\\n__PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 3000 });
    const found = out.split('__PATH__')[1]?.trim();
    if (found) process.env.PATH = found;
  } catch {}
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

// The last size and position, dropping a position that is on a display no longer attached.
function readBounds() {
  let b;
  try { b = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { width: 1440, height: 960 }; }
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) => b.x >= a.x && b.y >= a.y && b.x < a.x + a.width && b.y < a.y + a.height);
  return onScreen ? b : { width: b.width, height: b.height };
}

function createWindow() {
  win = new BrowserWindow({ ...readBounds(), backgroundColor: '#0b0d0c', title: 'Agents Visualizer', icon, autoHideMenuBar: true });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', () => fs.writeFileSync(STATE, JSON.stringify(win.getBounds())));
  win.loadURL(`http://127.0.0.1:${process.env.PORT}`);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// Network I/O only runs once the app is ready, so the server starts here.
app.whenReady().then(async () => {
  app.dock?.setIcon(icon);
  loginShellPath();
  process.env.PORT ||= String(await freePort());
  process.env.PRICES_FILE ||= path.join(app.getPath('userData'), 'prices.local.json');
  await import('../server.js');
  createWindow();
});

app.on('window-all-closed', () => app.quit());
