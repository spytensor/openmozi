import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDesktopMoziHome } from './migration.js';
import { prepareRuntimeAfterStatus } from './navigation.js';
import { desktopActionFromUrl, isRuntimeResourceUrl, isSafeExternalUrl, sanitizeDesktopError } from './security.js';
import { renderStatusPage } from './status-page.js';
import { MoziRuntimeSupervisor, resolveRuntimePaths, type DesktopRuntimeState } from './supervisor.js';

let mainWindow: BrowserWindow | null = null;
let supervisor: MoziRuntimeSupervisor | null = null;
let runtimeUrl = '';
let bootPromise: Promise<void> | null = null;
let quitPromise: Promise<void> | null = null;
let shutdownComplete = false;
let statusPageUrl = '';
const desktopDistDir = dirname(fileURLToPath(import.meta.url));
const selectDirectoryChannel = 'mozi:select-directory';
const buildInfoChannel = 'mozi:build-info';

app.setName('MOZI');
const desktopUserDataPath = join(app.getPath('appData'), 'MOZI');
mkdirSync(desktopUserDataPath, { recursive: true, mode: 0o700 });
app.setPath('userData', desktopUserDataPath);

async function loadStatus(state: DesktopRuntimeState): Promise<void> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  statusPageUrl = `data:text/html;charset=utf-8,${encodeURIComponent(renderStatusPage(state, app.getLocale()))}`;
  try {
    await win.loadURL(statusPageUrl);
  } catch (err: unknown) {
    if (!win.isDestroyed()) {
      const code = (err as { code?: unknown; errno?: unknown } | null)?.code
        ?? (err as { errno?: unknown } | null)?.errno;
      if (code === 'ERR_ABORTED' || code === -3) return;
      console.error('Failed to load MOZI status page:', typeof code === 'string' || typeof code === 'number' ? code : 'unknown_error');
    }
  }
}

async function loadRuntimeUrl(url: string): Promise<void> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    await win.loadURL(url);
  } catch (err) {
    if (!win.isDestroyed()) {
      throw err;
    }
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    title: 'MOZI',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0f1115',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(desktopDistDir, 'preload.cjs'),
    },
  });

  const handleAction = async (action: ReturnType<typeof desktopActionFromUrl>) => {
    if (!action || !supervisor) return;
    if (action === 'open-log') {
      const error = await shell.openPath(supervisor.getState().logPath);
      if (error) console.error('Failed to open MOZI runtime log:', error);
      return;
    }
    if (action === 'restart') await supervisor.stopOwnedProcess();
    await boot();
  };

  const handleBlockedUrl = (url: string) => {
    const action = desktopActionFromUrl(url);
    if (action) {
      void handleAction(action);
    } else if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (runtimeUrl && isRuntimeResourceUrl(url, runtimeUrl)) {
      void win.loadURL(url);
    } else {
      handleBlockedUrl(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url === statusPageUrl || (runtimeUrl && isRuntimeResourceUrl(url, runtimeUrl))) return;
    event.preventDefault();
    handleBlockedUrl(url);
  });
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.webContents.session.on('will-download', (event, item) => {
    if (!runtimeUrl || !isRuntimeResourceUrl(item.getURL(), runtimeUrl)) event.preventDefault();
  });

  return win;
}

ipcMain.handle(selectDirectoryChannel, async (event) => {
  const win = mainWindow;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) {
    throw new Error('Directory selection is unavailable');
  }
  const frameUrl = event.senderFrame?.url;
  if (!frameUrl || !runtimeUrl || !isRuntimeResourceUrl(frameUrl, runtimeUrl)) {
    throw new Error('Directory selection is unavailable outside the MOZI workspace');
  }
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a project folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return {
    canceled: result.canceled,
    path: result.canceled ? undefined : result.filePaths[0],
  };
});

ipcMain.handle(buildInfoChannel, async (event) => {
  const win = mainWindow;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) {
    throw new Error('Build identity is unavailable');
  }
  return { version: app.getVersion(), surface: 'desktop' as const };
});

async function boot(): Promise<void> {
  if (bootPromise) {
    return bootPromise;
  }
  bootPromise = bootOnce();
  try {
    await bootPromise;
  } finally {
    bootPromise = null;
  }
}

async function bootOnce(): Promise<void> {
  const paths = resolveRuntimePaths({
    appRoot: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged,
    env: process.env,
  });
  runtimeUrl = paths.runtimeUrl;
  const existingSupervisor = supervisor;
  supervisor ??= new MoziRuntimeSupervisor({ paths });
  if (!mainWindow) {
    mainWindow = createWindow();
    mainWindow.once('closed', () => {
      mainWindow = null;
    });
  }
  if (app.isPackaged && !process.env.MOZI_HOME) {
    await loadStatus(supervisor.getState());
    const migration = await prepareDesktopMoziHome({
      targetHome: paths.moziHome,
      legacyHome: process.env.MOZI_DESKTOP_LEGACY_HOME,
      healthUrl: paths.healthUrl,
      env: process.env,
    });
    if (migration.status === 'blocked') {
      await loadStatus({
        ...supervisor.getState(),
        status: 'failed',
        owner: 'none',
        error: migration.message ?? 'MOZI App Support migration is blocked.',
        checkedAt: new Date().toISOString(),
      });
      return;
    }
  }

  if (existingSupervisor && supervisor.getState().status === 'starting') {
    return;
  }

  const state = await prepareRuntimeAfterStatus(
    () => loadStatus(supervisor!.getState()),
    () => supervisor!.ensureReady(),
  );
  if (state.status === 'ready') {
    await loadRuntimeUrl(paths.runtimeUrl);
  } else {
    await loadStatus(state);
  }
}

app.whenReady().then(() => {
  void boot().catch((err: unknown) => {
    const message = sanitizeDesktopError(err);
    console.error('MOZI desktop boot failed:', message);
    if (supervisor) {
      void loadStatus({
        ...supervisor.getState(),
        status: 'failed',
        error: message,
        checkedAt: new Date().toISOString(),
      });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void boot();
  }
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  quitPromise ??= (async () => {
    try {
      await supervisor?.stopOwnedProcess();
    } catch (err) {
      console.error('Failed to stop the MOZI runtime cleanly:', err);
    } finally {
      shutdownComplete = true;
      app.quit();
    }
  })();
});
