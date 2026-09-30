/**
 * 33_Backup.gs — VERSION 1.0 (30.09.2026, этап 15.6)
 * Еженедельная копия таблицы на Google Диск (ревью, п. 1.4): защищает от удаления файла и ошибочного setup().
 *
 * Куда: папка «MassageOnline — резервные копии» (id запоминается в свойстве BACKUP_FOLDER_ID).
 * Сколько: последние config.backup_keep копий (по умолчанию 8 — два месяца), старые — в корзину Диска.
 * Когда: триггер weeklyBackup (воскресенье, 04:00) из installTriggers(); вручную — backupNow() из редактора.
 * Нужен доступ к Диску: при первом запуске Google спросит разрешение. Если в appsscript.json
 * перечислены oauthScopes — добавить https://www.googleapis.com/auth/drive.
 */

var BACKUP_FOLDER_NAME = 'MassageOnline — резервные копии';
var BACKUP_PREFIX = 'MassageOnline backup ';

function Backup_folder_() {
  var id = PROP('BACKUP_FOLDER_ID');
  if (id) {
    try {
      var f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* папку удалили — создадим заново */ }
  }
  var folder = DriveApp.createFolder(BACKUP_FOLDER_NAME);
  PROP_set('BACKUP_FOLDER_ID', folder.getId());
  return folder;
}

/** Делает копию и чистит старые. Возвращает текст для журнала. */
function backupNow() {
  var folder = Backup_folder_();
  var name = BACKUP_PREFIX + Utilities.formatDate(new Date(), TZ(), 'yyyy-MM-dd HH-mm');
  DriveApp.getFileById(SS().getId()).makeCopy(name, folder);

  var keep = parseInt(CFG_opt('backup_keep', '8'), 10);
  if (!(keep >= 1)) keep = 8;
  var files = [], it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (String(f.getName()).indexOf(BACKUP_PREFIX) === 0) files.push(f);
  }
  files.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; }); // имя = дата, свежие сверху
  var removed = 0;
  files.slice(keep).forEach(function (f) { f.setTrashed(true); removed++; });

  var msg = 'Копия «' + name + '» создана; хранится ' + Math.min(files.length, keep) + ', в корзину: ' + removed;
  console.log(msg);
  return msg;
}

/** Триггер. Ошибка — разработчику, чтобы молча не остаться без копий. */
function weeklyBackup() {
  var t0 = Date.now();
  try {
    var msg = backupNow();
    Audit_log('weeklyBackup', 'OK', Date.now() - t0, '', msg, 'trigger');
  } catch (e) {
    Audit_log('weeklyBackup', 'ERROR', Date.now() - t0, e.code || 'INTERNAL', e.message, 'trigger');
    Notify_dev('Резервная копия не создана: ' + e.message);
    throw e;
  }
}
