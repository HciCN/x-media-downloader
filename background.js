/**
 * X-Media-Downloader - Background Service Worker
 * 负责 Chrome 原生后台高速下载队列调度、文件命名及状态同步
 */

// 下载任务管理器
class DownloadManager {
  constructor() {
    this.queue = [];
    this.activeCount = 0;
    this.concurrency = 3; // 默认并发数
    this.completedCount = 0;
    this.failedCount = 0;
    this.totalCount = 0;
    this.activeTask = false;
  }

  setConcurrency(num) {
    this.concurrency = Math.max(1, Math.min(10, parseInt(num) || 3));
  }

  addBatch(items, folderName = 'X-Media') {
    this.totalCount = items.length;
    this.completedCount = 0;
    this.failedCount = 0;
    this.activeTask = true;

    for (const item of items) {
      this.queue.push({
        ...item,
        folderName,
        retries: 0
      });
    }

    this.processQueue();
  }

  clear() {
    this.queue = [];
    this.activeCount = 0;
    this.activeTask = false;
  }

  processQueue() {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.activeCount++;
      this.downloadItem(item);
    }
  }

  downloadItem(item) {
    const ext = item.mediaType === 'video' ? 'mp4' : 'jpg';
    // 格式化文件名：folder/博主_推文ID_序号.ext
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
          this.notifyProgress();
        }
        this.activeCount--;
        this.processQueue();
      } else {
        // 跟踪下载完成状态
        this.monitorDownload(downloadId);
      }
    });
  }

  monitorDownload(downloadId) {
    const checkStatus = (delta) => {
      if (delta.id === downloadId) {
        if (delta.state && delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(checkStatus);
          this.completedCount++;
          this.activeCount--;
          this.notifyProgress();
          this.processQueue();
        } else if (delta.error || (delta.state && delta.state.current === 'interrupted')) {
          chrome.downloads.onChanged.removeListener(checkStatus);
          this.failedCount++;
          this.activeCount--;
          this.notifyProgress();
          this.processQueue();
        }
      }
    };
    chrome.downloads.onChanged.addListener(checkStatus);
  }

  notifyProgress() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          source: 'XMD_BG',
          type: 'DOWNLOAD_PROGRESS',
          payload: {
            completed: this.completedCount,
            failed: this.failedCount,
            total: this.totalCount,
            active: this.activeCount,
            isFinished: (this.completedCount + this.failedCount >= this.totalCount) && this.queue.length === 0
          }
        }).catch(() => {});
      }
    });
  }
}

const manager = new DownloadManager();

// 接收来自 Content Script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.source !== 'XMD_CONTENT') return;

  const { type, payload } = message;

  if (type === 'START_DOWNLOAD_BATCH') {
    manager.setConcurrency(payload.concurrency || 3);
    manager.addBatch(payload.items, payload.folderName);
    sendResponse({ success: true, count: payload.items.length });
    return true;
  }

  if (type === 'CANCEL_DOWNLOAD_BATCH') {
    manager.clear();
    sendResponse({ success: true });
    return true;
  }

  if (type === 'GET_DOWNLOAD_STATUS') {
    sendResponse({
      completed: manager.completedCount,
      failed: manager.failedCount,
      total: manager.totalCount,
      active: manager.activeCount
    });
    return true;
  }
});
