(() => {
  'use strict';

  const api = window.setup;
  const $ = s => document.querySelector(s);

  let installedExe = '';
  let busy = false;

  async function boot() {
    const info = await api.info();
    $('#titleVer').textContent = `Vanilla++ ${info.version}`;
    $('#dir').value = info.defaultDir;
    if (info.sakura) $('#pano').src = info.sakura;
    api.onProgress(({ progress, text }) => {
      $('#progress').hidden = false;
      $('#fill').style.width = `${Math.round((progress || 0) * 100)}%`;
      if (text) $('#progText').textContent = text;
    });
  }

  $('#min').onclick = () => api.minimize();
  $('#close').onclick = () => api.close();
  $('#cancel').onclick = () => {
    if (!busy) api.close();
  };

  $('#browse').onclick = async () => {
    const dir = await api.pick();
    if (dir) $('#dir').value = dir;
  };

  $('#install').onclick = async () => {
    if (busy) {
      if (installedExe) await api.launch();
      return;
    }
    const dir = $('#dir').value.trim();
    if (!dir) {
      $('#err').textContent = 'Укажите папку установки';
      return;
    }
    busy = true;
    $('#err').textContent = '';
    $('#install').disabled = true;
    $('#browse').disabled = true;
    $('#dir').disabled = true;
    $('#cancel').disabled = true;
    $('#progress').hidden = false;
    $('#installLabel').textContent = 'Устанавливаем…';
    try {
      const result = await api.install({
        dir,
        desktop: $('#desktop').checked,
        startMenu: $('#startMenu').checked,
      });
      installedExe = result.exe;
      $('#fill').style.width = '100%';
      $('#progText').textContent = 'Установка завершена';
      $('#installLabel').textContent = 'Запустить';
      $('#install').disabled = false;
      const icon = $('#install use');
      if (icon) icon.setAttribute('href', '#i-check');
      $('#cancel').textContent = 'Закрыть';
      $('#cancel').disabled = false;
    } catch (e) {
      busy = false;
      $('#err').textContent = e.message;
      $('#install').disabled = false;
      $('#browse').disabled = false;
      $('#dir').disabled = false;
      $('#cancel').disabled = false;
      $('#installLabel').textContent = 'Установить';
      $('#progText').textContent = 'Не получилось';
    }
  };

  boot().catch(e => { $('#err').textContent = e.message; });
})();
