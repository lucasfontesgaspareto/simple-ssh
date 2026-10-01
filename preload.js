const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const send = (ch) => (...a) => ipcRenderer.send(ch, ...a);
const on = (ch) => (fn) => ipcRenderer.on(ch, (_, ...a) => fn(...a));

contextBridge.exposeInMainWorld('api', {
  open: invoke('ssh:open'), write: send('ssh:write'), resize: send('ssh:resize'), close: send('ssh:close'),
  onData: on('ssh:data'), onClose: on('ssh:close'), onToast: on('toast'),
  home: invoke('sftp:home'), list: invoke('sftp:list'), mkdir: invoke('sftp:mkdir'), rename: invoke('sftp:rename'),
  del: invoke('sftp:delete'), upload: invoke('sftp:upload'), download: invoke('sftp:download'), edit: invoke('sftp:edit'),
  conns: invoke('conn:list'), saveConn: invoke('conn:save'), deleteConn: invoke('conn:delete'), importMoba: invoke('conn:import'), exportMoba: invoke('conn:export'),
  pickKey: invoke('pick:key'), menu: invoke('menu'),
  filePath: (f) => webUtils.getPathForFile(f),
});
