const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

ipcMain.handle('save-invoice-pdf', async (event, { html, invoiceNumber, format }) => {
  if (!html) throw new Error('Invoice content is empty.');

  const pdfWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pageSize = format === 'A4'
      ? 'A4'
      : format === 'A5'
        ? 'A5'
        : { width: 80000, height: 200000 };
    const pdfData = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      pageSize,
      margins: { marginType: 'printableArea' },
    });
    const saveResult = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Save Invoice as PDF',
      defaultPath: path.join(app.getPath('documents'), `${invoiceNumber || 'invoice'}.pdf`),
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });
    if (saveResult.canceled || !saveResult.filePath) return { canceled: true };
    fs.writeFileSync(saveResult.filePath, pdfData);
    return { canceled: false, filePath: saveResult.filePath };
  } finally {
    if (!pdfWindow.isDestroyed()) pdfWindow.close();
  }
});

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