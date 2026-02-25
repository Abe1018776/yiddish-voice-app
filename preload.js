const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer -> Main (fire-and-forget)
  send: (channel, data) => {
    const allowed = [
      'start-recording',
      'stop-recording',
      'transcribe',
      'open-settings',
      'set-ignore-mouse',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },

  // Renderer -> Main (request/response)
  invoke: (channel, data) => {
    const allowed = [
      'get-config',
      'save-config',
      'paste-text',
      'history-get',
      'history-clear',
      'history-delete',
      'copy-to-clipboard',
      'select-file',
    ];
    if (allowed.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    }
    return Promise.reject(new Error(`Channel "${channel}" not allowed`));
  },

  // Main -> Renderer (listen)
  on: (channel, callback) => {
    const allowed = [
      'start-recording',
      'stop-recording',
      'toggle-recording',
      'transcription-result',
      'history-new-entry',
    ];
    if (allowed.includes(channel)) {
      const subscription = (_event, ...args) => callback(...args);
      ipcRenderer.on(channel, subscription);
      return () => ipcRenderer.removeListener(channel, subscription);
    }
  },
});
