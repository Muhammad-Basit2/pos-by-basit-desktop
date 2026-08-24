const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, 'assets/poslogo.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      partition: 'persist:pos-by-basit'
    }
  });

  // Load the index.html file
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});