// Electron main process. This is what makes double-clicking the app icon
// "just work" — it starts the same server the Docker version used, but
// running directly inside the app itself instead of in a separate
// container, then opens a normal window pointed at it. No Docker, no
// terminal, no separate steps.

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const PORT = 51739;
let mainWindow;

function startServer() {
  // Where your data lives: a plain "Keepsake Data" folder inside your
  // Documents folder, so it's easy to find if you ever want to back it
  // up or look inside — no configuration needed, it's created
  // automatically the first time the app runs.
  const dataRoot = path.join(app.getPath('documents'), 'Keepsake Data');
  process.env.MEDIA_DIR = dataRoot;
  process.env.DATA_DIR = path.join(dataRoot, 'database');
  process.env.PORT = String(PORT);

  // Loads and starts the existing server code as-is — same routes, same
  // database logic, same everything. Only how it's launched has changed.
  require('../backend/server.js');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: 'Keepsake',
    backgroundColor: '#FBF7EF',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // If anything ever tries to open a link in a new window/tab, send it
  // to the person's normal web browser instead of inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
