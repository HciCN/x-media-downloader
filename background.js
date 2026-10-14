/**
 * X-Media-Downloader - Background Service Worker
 * 负责 Chrome 原生后台下载队列调度、多任务持久化存储 (Local Tasks DB)、
 * 控制台消息路由及与前台通信
 */

// 默认配置
const DEFAULT_SETTINGS = {
  concurrency: 4,
  folderTemplate: 'X-Media/{username}',
  filenameTemplate: '{username}_{tweet_id}_{index}',
  skipRetweets: true,
  highestQuality: true
};

// 本地存储键名定义
const STORAGE_KEYS = {
  TASKS_INDEX: 'xmd_tasks_index',
  TASK_PREFIX: 'xmd_task:',
  ITEMS_PREFIX: 'xmd_task_items:',
  SETTINGS: 'xmd_settings'
};

// 下载任务管理器
class DownloadManager {
  constructor() {
    this.queue = [];
    this.activeCount = 0;
    this.concurrency = 4;
    this.completedCount = 0;
    this.failedCount = 0;
    this.totalCount = 0;
    this.currentTaskId = null;
    this.isPaused = false;
  }

  setConcurrency(num) {
    this.concurrency = Math.max(1, Math.min(10, parseInt(num) || 4));
  }

  addBatch(items, folderName = 'X-Media', taskId = null) {
    this.currentTaskId = taskId;
    this.totalCount = items.length;
    this.completedCount = 0;
    this.failedCount = 0;
    this.isPaused = false;

    for (const item of items) {
      this.queue.push({
        ...item,
        folderName,
        retries: 0
      });
    }

    this.processQueue();
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
    this.processQueue();
  }

  clear() {
    this.queue = [];
    this.activeCount = 0;
    this.currentTaskId = null;
    this.isPaused = false;
  }

  processQueue() {
    if (this.isPaused) return;

    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.activeCount++;
      this.downloadItem(item);
    }
  }

  async downloadItem(item) {
    const ext = item.mediaType === 'video' ? 'mp4' : 'jpg';
    const cleanUser = (item.user?.screen_name || 'unknown').replace(/[\\/:*?"<>|]/g, '');
    const cleanId = (item.tweetId || 'media').replace(/[\\/:*?"<>|]/g, '');
    const itemIdx = (item.id || '').slice(-4);
    const filename = `${item.folderName}/${cleanUser}_${cleanId}_${itemIdx}.${ext}`;

    chrome.downloads.download({
      url: item.mediaUrl,
      filename: filename,
      conflictAction: 'uniquify',
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        console.warn('[XMD-BG] Download error:', chrome.runtime.lastError?.message);
        if (item.retries < 2) {
          item.retries++;
          this.queue.push(item);
        } else {
          this.failedCount++;
          this.updateItemPersistence(item, 'failed');
          this.notifyProgress();
        }
        this.activeCount--;
        this.processQueue();
      } else {
        this.monitorDownload(downloadId, item);
      }
    });
  }

  monitorDownload(downloadId, item) {
    const checkStatus = (delta) => {
      if (delta.id === downloadId) {
        if (delta.state && delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(checkStatus);
          this.completedCount++;
          this.activeCount--;
          this.updateItemPersistence(item, 'completed');
          this.notifyProgress();
          this.processQueue();
        } else if (delta.error || (delta.state && delta.state.current === 'interrupted')) {
          chrome.downloads.onChanged.removeListener(checkStatus);
          this.failedCount++;
          this.activeCount--;
          this.updateItemPersistence(item, 'failed');
          this.notifyProgress();
          this.processQueue();
        }
      }
    };
    chrome.downloads.onChanged.addListener(checkStatus);
  }

  async updateItemPersistence(item, status) {
    if (!this.currentTaskId) return;
    try {
      const itemsKey = STORAGE_KEYS.ITEMS_PREFIX + this.currentTaskId;
      const res = await chrome.storage.local.get([itemsKey]);
      const itemsMap = res[itemsKey] || {};
      if (itemsMap[item.id]) {
        itemsMap[item.id].download_status = status;
        itemsMap[item.id].downloaded_at = Date.now();
        await chrome.storage.local.set({ [itemsKey]: itemsMap });
      }

      // 同时更新任务总计
      const taskKey = STORAGE_KEYS.TASK_PREFIX + this.currentTaskId;
      const tRes = await chrome.storage.local.get([taskKey]);
      const task = tRes[taskKey];
      if (task) {
        task.completed_count = this.completedCount;
        task.failed_count = this.failedCount;
        task.updated_at = Date.now();
        if (this.completedCount + this.failedCount >= task.media_count) {
          task.status = this.failedCount > 0 ? 'completed_with_errors' : 'completed';
          task.finished_at = Date.now();
        } else {
          task.status = 'running';
        }
        await chrome.storage.local.set({ [taskKey]: task });
      }
    } catch (e) {
      console.warn('[XMD-BG] Error updating task persistence:', e);
    }
  }

  notifyProgress() {
    const isFinished = (this.completedCount + this.failedCount >= this.totalCount) && this.queue.length === 0;

    const payload = {
      completed: this.completedCount,
      failed: this.failedCount,
      total: this.totalCount,
      active: this.activeCount,
      isFinished,
      taskId: this.currentTaskId
    };

    // 广播给所有打开的标签页（包括当前推文页与 Dashboard 页面）
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, {
            source: 'XMD_BG',
            type: 'DOWNLOAD_PROGRESS',
            payload
          }).catch(() => {});
        }
      }
    });
  }
}

const manager = new DownloadManager();

// 点击工具栏扩展图标时，自动打开或聚焦 Dashboard 页面
chrome.action.onClicked.addListener(() => {
  openDashboard();
});

function openDashboard(taskId = '') {
  const url = chrome.runtime.getURL(`dashboard.html${taskId ? '?id=' + taskId : ''}`);
  chrome.tabs.query({ url: chrome.runtime.getURL('dashboard.html*') }, (tabs) => {
    if (tabs && tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true, url });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url, active: true });
    }
  });
}

// 消息路由器
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  const { type, payload } = message;

  // 1. 打开控制台
  if (type === 'OPEN_DASHBOARD') {
    openDashboard(payload?.taskId || '');
    sendResponse({ success: true });
    return true;
  }

  // 2. 启动原生批量下载
  if (type === 'START_DOWNLOAD_BATCH') {
    manager.setConcurrency(payload.concurrency || 4);
    manager.addBatch(payload.items, payload.folderName, payload.taskId);
    sendResponse({ success: true, count: payload.items.length });
    return true;
  }

  if (type === 'PAUSE_DOWNLOAD_BATCH') {
    manager.pause();
    sendResponse({ success: true });
    return true;
  }

  if (type === 'RESUME_DOWNLOAD_BATCH') {
    manager.resume();
    sendResponse({ success: true });
    return true;
  }

  if (type === 'CANCEL_DOWNLOAD_BATCH') {
    manager.clear();
    sendResponse({ success: true });
    return true;
  }

  // 3. 创建/保存本地任务 (Local Task)
  if (type === 'CREATE_LOCAL_TASK') {
    handleCreateTask(payload).then(res => sendResponse(res));
    return true;
  }

  // 4. 获取任务列表
  if (type === 'GET_TASK_LIST') {
    handleGetTaskList().then(res => sendResponse(res));
    return true;
  }

  // 5. 获取单任务详情
  if (type === 'GET_TASK_DETAIL') {
    handleGetTaskDetail(payload?.taskId).then(res => sendResponse(res));
    return true;
  }

  // 6. 删除任务
  if (type === 'DELETE_TASK') {
    handleDeleteTask(payload?.taskId).then(res => sendResponse(res));
    return true;
  }

  // 7. 设置读取与保存
  if (type === 'GET_SETTINGS') {
    chrome.storage.local.get([STORAGE_KEYS.SETTINGS], (res) => {
      sendResponse(res[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS);
    });
    return true;
  }

  if (type === 'SAVE_SETTINGS') {
    chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: payload }, () => {
      manager.setConcurrency(payload.concurrency);
      sendResponse({ success: true });
    });
    return true;
  }

  // 8. 全量同步任务到 Python 局域网远程服务
  if (type === 'SYNC_ALL_TO_REMOTE') {
    handleSyncAllToRemote().then(res => sendResponse(res));
    return true;
  }
});

// --- 本地任务数据库持久化逻辑 ---

async function handleCreateTask(data) {
  try {
    const taskId = crypto.randomUUID();
    const now = Date.now();

    const taskMeta = {
      id: taskId,
      task_name: data.task_name || (data.user?.name ? `${data.user.name} 的媒体库` : '媒体抓取任务'),
      x_uid: data.user?.rest_id || null,
      x_screen_name: data.user?.screen_name || '',
      x_name: data.user?.name || '',
      x_avatar: data.user?.avatar || '',
      x_description: data.user?.description || '',
      status: 'pending',
      created_at: now,
      updated_at: now,
      media_count: (data.media_items || []).length,
      completed_count: 0,
      failed_count: 0,
      finished_at: null
    };

    const itemsMap = {};
    for (const item of (data.media_items || [])) {
      const itemId = item.id || crypto.randomUUID();
      itemsMap[itemId] = {
        ...item,
        id: itemId,
        task_id: taskId,
        download_status: 'pending',
        created_at: now
      };
    }

    // 存储任务详情与条目
    await chrome.storage.local.set({
      [STORAGE_KEYS.TASK_PREFIX + taskId]: taskMeta,
      [STORAGE_KEYS.ITEMS_PREFIX + taskId]: itemsMap
    });

    // 登记到任务索引
    const res = await chrome.storage.local.get([STORAGE_KEYS.TASKS_INDEX]);
    const index = res[STORAGE_KEYS.TASKS_INDEX] || [];
    if (!index.includes(taskId)) {
      await chrome.storage.local.set({ [STORAGE_KEYS.TASKS_INDEX]: [taskId, ...index] });
    }

    // 自动推送该新任务至 Python 局域网远程服务
    getRemoteServerUrl().then(remoteBase => {
      fetch(`${remoteBase}/api/sync_task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: taskMeta, items: Object.values(itemsMap) })
      }).catch(() => {});
    });

    return { success: true, taskId, count: taskMeta.media_count };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getRemoteServerUrl() {
  const ports = [8899, 8080, 18080, 28080];
  for (const p of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/api/lan_info`);
      if (res.ok) return `http://127.0.0.1:${p}`;
    } catch(e) {}
  }
  return 'http://127.0.0.1:8899';
}

async function handleGetTaskList() {
  try {
    const res = await chrome.storage.local.get([STORAGE_KEYS.TASKS_INDEX]);
    const index = res[STORAGE_KEYS.TASKS_INDEX] || [];

    const tasks = [];
    for (const id of index) {
      const tRes = await chrome.storage.local.get([STORAGE_KEYS.TASK_PREFIX + id]);
      const task = tRes[STORAGE_KEYS.TASK_PREFIX + id];
      if (task) tasks.push(task);
    }
    return { success: true, tasks };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleGetTaskDetail(taskId) {
  if (!taskId) return { success: false, error: 'taskId required' };
  try {
    const taskKey = STORAGE_KEYS.TASK_PREFIX + taskId;
    const itemsKey = STORAGE_KEYS.ITEMS_PREFIX + taskId;

    const res = await chrome.storage.local.get([taskKey, itemsKey]);
    const task = res[taskKey];
    const items = res[itemsKey] || {};

    if (!task) return { success: false, error: 'Task not found' };

    return {
      success: true,
      task,
      items: Object.values(items).sort((a, b) => b.created_at - a.created_at)
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleDeleteTask(taskId) {
  if (!taskId) return { success: false, error: 'taskId required' };
  try {
    const taskKey = STORAGE_KEYS.TASK_PREFIX + taskId;
    const itemsKey = STORAGE_KEYS.ITEMS_PREFIX + taskId;
    await chrome.storage.local.remove([taskKey, itemsKey]);

    const res = await chrome.storage.local.get([STORAGE_KEYS.TASKS_INDEX]);
    const index = (res[STORAGE_KEYS.TASKS_INDEX] || []).filter(id => id !== taskId);
    await chrome.storage.local.set({ [STORAGE_KEYS.TASKS_INDEX]: index });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleSyncAllToRemote() {
  try {
    const remoteBase = await getRemoteServerUrl();
    const res = await chrome.storage.local.get([STORAGE_KEYS.TASKS_INDEX]);
    const index = res[STORAGE_KEYS.TASKS_INDEX] || [];
    let syncedCount = 0;

    for (const taskId of index) {
      const tKey = STORAGE_KEYS.TASK_PREFIX + taskId;
      const iKey = STORAGE_KEYS.ITEMS_PREFIX + taskId;
      const data = await chrome.storage.local.get([tKey, iKey]);
      const task = data[tKey];
      const itemsMap = data[iKey] || {};
      const items = Object.values(itemsMap);

      if (task) {
        await fetch(`${remoteBase}/api/sync_task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task, items })
        }).catch(() => {});
        syncedCount++;
      }
    }
    return { success: true, count: syncedCount };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
