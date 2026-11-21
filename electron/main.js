// Electron shell: runs the dashboard server in-process and shows it in a native window.
import { app, BrowserWindow, shell, nativeImage } from 'electron';
import net from 'node:net';
import path from 'node:path';

const icon = nativeImage.createFromPath(path.join(import.meta.dirname, 'icon.png'));

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

// Network I/O only runs once the app is ready, so the server starts here.
app.whenReady().then(async () => {
  app.dock?.setIcon(icon);
  process.env.PORT ||= String(await freePort());
  await import('../server.js');
  const win = new BrowserWindow({ width: 1440, height: 960, backgroundColor: '#0b0d0c', title: 'Agents Visualizer', icon });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${process.env.PORT}`);
});

app.on('window-all-closed', () => app.quit());
