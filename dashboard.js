/**
 * X-Media-Downloader - Dashboard Controller (SPA)
 * 仿 Plucker XBD 核心任务工作台：任务持久化查看、大屏进度追踪、
 * 细粒度媒体勾选、ZIP 打包、断点并发下载与全局配置
 */

(function () {
  'use strict';

  // 环境嗅探：判断是 Chrome 扩展环境，还是手机端/纯 Web 局域网访问环境
  const isExtensionContext = typeof chrome !== 'undefined' && Boolean(chrome?.runtime?.id);

  // 全局页面状态
  const state = {
    currentView: 'tasks', // 'tasks', 'detail', 'settings'
    viewMode: 'grid', // 'grid', 'tweets'
    tasks: [],
    currentTask: null,
    currentItems: [],
    selectedIds: new Set(),
    activeFilter: 'all', // 'all', 'image', 'video', 'failed'
    settings: {
      concurrency: 4,
      folderTemplate: 'X-Media/{username}',
      filenameTemplate: '{username}_{tweet_id}_{index}',
      skipRetweets: true
    }
  };

  // --- 初始化启动 ---
  document.addEventListener('DOMContentLoaded', async () => {
    bindNavigation();
    bindSettingsEvents();
    bindDetailActions();
    bindLightboxEvents();
    bindRemoteHubEvents();

    // 如果处于手机浏览器环境，显示移动端徽标
    if (!isExtensionContext) {
      const mobileBadge = document.getElementById('mobile-mode-badge');
      if (mobileBadge) mobileBadge.style.display = 'inline-block';
    }

    // 检查 URL 是否带 task ID
    const urlParams = new URLSearchParams(window.location.search);
    const taskId = urlParams.get('id');

    await loadSettings();

    if (taskId) {
      await loadTaskDetail(taskId);
    } else {
      await loadTaskList();
    }

    // 仅在 Chrome 扩展环境下监听来自后台的实时下载进度
    if (isExtensionContext && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.source === 'XMD_BG' && msg.type === 'DOWNLOAD_PROGRESS') {
          onDownloadProgressUpdate(msg.payload);
        }
      });
    }
  });

  // --- 导航与视图切换 ---
  function bindNavigation() {
    document.getElementById('nav-brand-btn').onclick = (e) => {
      e.preventDefault();
      switchView('tasks');
    };

    document.getElementById('tab-btn-tasks').onclick = () => switchView('tasks');
    document.getElementById('tab-btn-detail').onclick = () => switchView('detail');
    document.getElementById('tab-btn-remote').onclick = () => switchView('remote');
    document.getElementById('tab-btn-settings').onclick = () => switchView('settings');

    document.getElementById('detail-back-btn').onclick = () => switchView('tasks');

    // 搜索过滤
    document.getElementById('task-search-input').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      renderTaskList(q);
    };
  }

  function switchView(viewName) {
    state.currentView = viewName;

    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-tab-btn').forEach(el => el.classList.remove('active'));

    if (viewName === 'tasks') {
      document.getElementById('view-task-list').classList.add('active');
      document.getElementById('tab-btn-tasks').classList.add('active');
      loadTaskList();
    } else if (viewName === 'detail') {
      document.getElementById('view-task-detail').classList.add('active');
      document.getElementById('tab-btn-detail').classList.add('active');
      document.getElementById('tab-btn-detail').style.display = 'inline-flex';
    } else if (viewName === 'remote') {
      document.getElementById('view-remote').classList.add('active');
      document.getElementById('tab-btn-remote').classList.add('active');
    } else if (viewName === 'settings') {
      document.getElementById('view-settings').classList.add('active');
      document.getElementById('tab-btn-settings').classList.add('active');
    }
  }

  // =========================================================================
  // 1. 任务列表视图逻辑
  // =========================================================================
  async function loadTaskList() {
    if (isExtensionContext) {
      chrome.runtime.sendMessage({ type: 'GET_TASK_LIST' }, (res) => {
        if (res && res.success) {
          state.tasks = res.tasks || [];
          renderTaskList();
          // 静默同步任务至 Python 远程服务
          syncAllTasksToRemote();
        }
      });
    } else {
      // 手机端/外部浏览器访问：直接走本地远程 HTTP API
      try {
        const res = await fetch('/api/tasks').then(r => r.json());
        if (res && res.success) {
          state.tasks = res.tasks || [];
          renderTaskList();
        }
      } catch (err) {
        console.warn('获取远程任务列表失败:', err);
      }
    }
  }

  function renderTaskList(searchQuery = '') {
    const container = document.getElementById('task-cards-container');
    const emptyEl = document.getElementById('task-list-empty');
    container.innerHTML = '';

    let filtered = state.tasks;
    if (searchQuery) {
      filtered = filtered.filter(t =>
        (t.x_name || '').toLowerCase().includes(searchQuery) ||
        (t.x_screen_name || '').toLowerCase().includes(searchQuery) ||
        (t.task_name || '').toLowerCase().includes(searchQuery)
      );
    }

    if (filtered.length === 0) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    filtered.forEach(t => {
      const card = document.createElement('div');
      card.className = 'task-card';

      const pct = t.media_count > 0 ? Math.round((t.completed_count / t.media_count) * 100) : 0;
      const statusBadgeClass = {
        running: 'badge-running',
        completed: 'badge-done',
        pending: 'badge-queued',
        failed: 'badge-error'
      }[t.status] || 'badge-queued';

      card.innerHTML = `
        <div class="task-card-top">
          <div class="task-card-user">
            <img class="task-card-avatar" src="${t.x_avatar || ''}" />
            <div>
              <div class="task-card-name">${t.x_name || t.task_name || '未命名任务'}</div>
              <div class="task-card-handle">@${t.x_screen_name || 'unknown'}</div>
            </div>
          </div>
          <span class="status-badge ${statusBadgeClass}">${t.status}</span>
        </div>

        <div class="task-card-progress">
          <div class="task-card-progress-fill" style="width:${pct}%"></div>
        </div>

        <div class="task-card-stats">
          <span>完成度: ${t.completed_count} / ${t.media_count} (${pct}%)</span>
          <span>${new Date(t.created_at).toLocaleDateString()}</span>
        </div>
      `;

      const avatarEl = card.querySelector('.task-card-avatar');
      if (avatarEl) {
        if (!t.x_avatar) {
          avatarEl.style.display = 'none';
        } else {
          avatarEl.addEventListener('error', () => {
            avatarEl.style.display = 'none';
          });
        }
      }

      card.onclick = () => {
        loadTaskDetail(t.id);
      };

      container.appendChild(card);
    });
  }

  // =========================================================================
  // 2. 任务详情与下载大屏逻辑
  // =========================================================================
  async function loadTaskDetail(taskId) {
    if (isExtensionContext) {
      chrome.runtime.sendMessage({ type: 'GET_TASK_DETAIL', payload: { taskId } }, (res) => {
        if (res && res.success) {
          state.currentTask = res.task;
          state.currentItems = res.items || [];
          state.selectedIds.clear();
          // 默认全选
          state.currentItems.forEach(it => state.selectedIds.add(it.id));

          renderDetailDashboard();
          switchView('detail');

          // 静默同步当前任务和媒体至 Python 远程服务
          syncSingleTaskToRemote(res.task, res.items);
        } else {
          alert('加载任务详情失败: ' + (res?.error || '未知错误'));
        }
      });
    } else {
      // 手机端/外部浏览器访问：通过 HTTP API 获取单任务详情
      try {
        const res = await fetch(`/api/task_detail?id=${encodeURIComponent(taskId || '')}`).then(r => r.json());
        if (res && res.success && res.task) {
          state.currentTask = res.task;
          state.currentItems = res.items || [];
          state.selectedIds.clear();
          state.currentItems.forEach(it => state.selectedIds.add(it.id));

          renderDetailDashboard();
          switchView('detail');
        } else {
          alert('远程服务中暂无此任务数据，请在电脑端打开该任务以自动完成同步。');
        }
      } catch (err) {
        console.warn('加载远程任务详情失败:', err);
      }
    }
  }

  function renderDetailDashboard() {
    const t = state.currentTask;
    if (!t) return;

    // 博主信息
    document.getElementById('detail-name').textContent = t.x_name || t.task_name || '未命名博主';
    document.getElementById('detail-handle').textContent = `@${t.x_screen_name || 'unknown'}`;
    document.getElementById('detail-bio').textContent = t.x_description || '';
    const avatarEl = document.getElementById('detail-avatar');
    if (t.x_avatar) {
      avatarEl.src = t.x_avatar;
      avatarEl.style.display = 'block';
    } else {
      avatarEl.style.display = 'none';
    }

    // 状态徽标
    const badgeEl = document.getElementById('detail-status-badge');
    badgeEl.textContent = t.status;
    badgeEl.className = 'status-badge ' + (
      t.status === 'running' ? 'badge-running' :
      t.status === 'completed' ? 'badge-done' :
      t.status === 'failed' ? 'badge-error' : 'badge-queued'
    );

    // 计算统计指标
    let completed = 0, failed = 0, pending = 0, imgCount = 0, vidCount = 0;
    for (const item of state.currentItems) {
      if (item.download_status === 'completed') completed++;
      else if (item.download_status === 'failed') failed++;
      else pending++;

      if (item.mediaType === 'video') vidCount++;
      else imgCount++;
    }

    const total = state.currentItems.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    // 四格指标看板
    document.getElementById('board-total').textContent = total;
    document.getElementById('board-completed').textContent = completed;
    document.getElementById('board-pending').textContent = pending;
    document.getElementById('board-failed').textContent = failed;

    // 进度条
    document.getElementById('detail-progress-summary').textContent = `已下载完成: ${completed} / ${total}`;
    document.getElementById('detail-progress-pct').textContent = `${pct}%`;
    const fillEl = document.getElementById('detail-progress-fill');
    fillEl.style.width = `${pct}%`;
    if (t.status === 'running') fillEl.classList.add('running');
    else fillEl.classList.remove('running');

    // 筛选标签数量
    document.getElementById('count-all').textContent = total;
    document.getElementById('count-images').textContent = imgCount;
    document.getElementById('count-videos').textContent = vidCount;
    document.getElementById('count-failed').textContent = failed;

    updateSelectedCountUI();
    renderActiveView();
  }

  function updateSelectedCountUI() {
    document.getElementById('selected-items-count').textContent = state.selectedIds.size;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getFilteredItems() {
    let filtered = state.currentItems;
    if (state.activeFilter === 'image') filtered = filtered.filter(it => it.mediaType === 'image');
    else if (state.activeFilter === 'video') filtered = filtered.filter(it => it.mediaType === 'video');
    else if (state.activeFilter === 'failed') filtered = filtered.filter(it => it.download_status === 'failed');
    return filtered;
  }

  function renderActiveView() {
    const grid = document.getElementById('media-waterfall-grid');
    const tweetsCont = document.getElementById('tweets-waterfall-container');
    if (!grid || !tweetsCont) return;

    if (state.viewMode === 'tweets') {
      grid.style.display = 'none';
      tweetsCont.style.display = 'flex';
      renderTweetsWaterfall();
    } else {
      tweetsCont.style.display = 'none';
      grid.style.display = 'grid';
      renderMediaWaterfall();
    }
  }

  function createMediaCardElement(it) {
    const itemEl = document.createElement('div');
    itemEl.className = 'gallery-item' + (state.selectedIds.has(it.id) ? ' selected' : '');
    itemEl.setAttribute('data-id', it.id);

    const isChecked = state.selectedIds.has(it.id);
    const dotClass = it.download_status === 'completed' ? 'dot-completed' :
                     it.download_status === 'failed' ? 'dot-failed' : 'dot-pending';
    const tweetUrl = it.tweetId ? `https://x.com/i/status/${it.tweetId}` : '';
    const textPreview = escapeHtml(it.tweetText || '');
    const textDisplay = it.tweetText ? (it.tweetText.slice(0, 36) + (it.tweetText.length > 36 ? '...' : '')) : '查看原推文';

    itemEl.innerHTML = `
      <input type="checkbox" class="gallery-checkbox" ${isChecked ? 'checked' : ''} />
      <span class="gallery-status-dot ${dotClass}" title="状态: ${it.download_status || 'pending'}"></span>
      <img class="gallery-thumb-img" src="${it.thumbUrl || it.mediaUrl}" loading="lazy" />
      <span class="gallery-badge">${it.mediaType === 'video' ? 'MP4' : 'IMG'}</span>
      <div class="gallery-item-overlay">
        <div class="gallery-item-text" title="${textPreview}">${escapeHtml(textDisplay)}</div>
        <div class="gallery-item-footer">
          ${tweetUrl ? `<a href="${tweetUrl}" target="_blank" class="gallery-tweet-link" title="在 X 查看原推文">查看原推 ↗</a>` : ''}
        </div>
      </div>
    `;

    // 勾选事件
    const cb = itemEl.querySelector('.gallery-checkbox');
    cb.onclick = (e) => {
      e.stopPropagation();
      if (cb.checked) {
        state.selectedIds.add(it.id);
        itemEl.classList.add('selected');
      } else {
        state.selectedIds.delete(it.id);
        itemEl.classList.remove('selected');
      }
      updateSelectedCountUI();
    };

    // 阻止原推链接冒泡触发 Lightbox
    const tweetLink = itemEl.querySelector('.gallery-tweet-link');
    if (tweetLink) {
      tweetLink.onclick = (e) => {
        e.stopPropagation();
      };
    }

    // 图片加载失败时降级回退到原媒体链接
    const imgEl = itemEl.querySelector('.gallery-thumb-img');
    if (imgEl) {
      imgEl.addEventListener('error', () => {
        if (imgEl.src !== it.mediaUrl) {
          imgEl.src = it.mediaUrl;
        }
      });
    }

    // 点击打开 Lightbox 播放/查看
    itemEl.onclick = () => {
      openLightbox(it);
    };

    return itemEl;
  }

  // 渲染媒体瀑布流画廊
  function renderMediaWaterfall() {
    const grid = document.getElementById('media-waterfall-grid');
    grid.innerHTML = '';

    const filtered = getFilteredItems();
    if (filtered.length === 0) {
      grid.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">当前筛选条件下暂无媒体</div>';
      return;
    }

    filtered.forEach(it => {
      grid.appendChild(createMediaCardElement(it));
    });
  }

  // 渲染推文分组卡片流
  function renderTweetsWaterfall() {
    const container = document.getElementById('tweets-waterfall-container');
    container.innerHTML = '';

    const filtered = getFilteredItems();
    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state">当前筛选条件下暂无推文媒体</div>';
      return;
    }

    // 按 tweetId 分组
    const groups = new Map();
    for (const item of filtered) {
      const key = item.tweetId || 'unknown';
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(item);
    }

    groups.forEach((items, tweetId) => {
      const first = items[0] || {};
      const card = document.createElement('div');
      card.className = 'dashboard-tweet-card';

      let dateStr = '';
      if (first.createdAt) {
        try {
          const d = new Date(first.createdAt);
          dateStr = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        } catch (e) {}
      }

      const tweetUrl = tweetId && tweetId !== 'unknown' ? `https://x.com/i/status/${tweetId}` : '';

      card.innerHTML = `
        <div class="dashboard-tweet-header">
          <div class="dashboard-tweet-meta">
            <span style="font-weight:700; color:var(--text-main);">推文 ID: ${tweetId}</span>
            ${dateStr ? `<span>•</span><span>${dateStr}</span>` : ''}
          </div>
          ${tweetUrl ? `
            <a href="${tweetUrl}" target="_blank" class="dashboard-view-tweet-btn" title="在 X/Twitter 查看原推文">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              在 X 查看原推文 ↗
            </a>
          ` : ''}
        </div>
        ${first.tweetText ? `<div class="dashboard-tweet-body">${escapeHtml(first.tweetText)}</div>` : ''}
        <div class="dashboard-tweet-media-grid"></div>
        <div class="dashboard-tweet-footer">
          <span>包含 <strong>${items.length}</strong> 个媒体</span>
          <button class="btn btn-secondary btn-download-group" style="padding:4px 10px; font-size:12px;">下载本推媒体 (${items.length})</button>
        </div>
      `;

      const mediaGrid = card.querySelector('.dashboard-tweet-media-grid');
      items.forEach(it => {
        mediaGrid.appendChild(createMediaCardElement(it));
      });

      const groupDlBtn = card.querySelector('.btn-download-group');
      if (groupDlBtn) {
        groupDlBtn.onclick = () => {
          const folderName = `X-Media/${state.currentTask?.x_screen_name || 'unknown'}`;
          chrome.runtime.sendMessage({
            source: 'XMD_CONTENT',
            type: 'START_DOWNLOAD_BATCH',
            payload: {
              items: items,
              folderName,
              concurrency: state.settings.concurrency || 4,
              taskId: state.currentTask?.id
            }
          });
        };
      }

      container.appendChild(card);
    });
  }

  // 绑定控制按钮事件
  function bindDetailActions() {
    // 视图模式切换（平铺画廊 vs 推文卡片流）
    const viewModeSelect = document.getElementById('dashboard-view-mode');
    if (viewModeSelect) {
      viewModeSelect.value = state.viewMode || 'grid';
      viewModeSelect.onchange = (e) => {
        state.viewMode = e.target.value;
        renderActiveView();
      };
    }

    // 筛选标签
    document.querySelectorAll('.gallery-filters .filter-pill').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.gallery-filters .filter-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.activeFilter = btn.getAttribute('data-filter');
        renderActiveView();
      };
    });

    // 全选/全不选/反选
    document.getElementById('btn-select-all').onclick = () => {
      state.currentItems.forEach(it => state.selectedIds.add(it.id));
      updateSelectedCountUI();
      renderActiveView();
    };

    document.getElementById('btn-select-none').onclick = () => {
      state.selectedIds.clear();
      updateSelectedCountUI();
      renderActiveView();
    };

    document.getElementById('btn-select-invert').onclick = () => {
      state.currentItems.forEach(it => {
        if (state.selectedIds.has(it.id)) state.selectedIds.delete(it.id);
        else state.selectedIds.add(it.id);
      });
      updateSelectedCountUI();
      renderActiveView();
    };

    // 开始批量下载
    document.getElementById('btn-start-download').onclick = () => {
      if (!state.currentTask) return;
      const targetItems = state.currentItems.filter(it => it.download_status !== 'completed');
      if (targetItems.length === 0) {
        alert('当前任务中所有媒体均已下载完成！');
        return;
      }

      const folderName = `X-Media/${state.currentTask.x_screen_name || 'unknown'}`;
      chrome.runtime.sendMessage({
        source: 'XMD_CONTENT',
        type: 'START_DOWNLOAD_BATCH',
        payload: {
          items: targetItems,
          folderName,
          concurrency: state.settings.concurrency || 4,
          taskId: state.currentTask.id
        }
      }, () => {
        state.currentTask.status = 'running';
        renderDetailDashboard();
      });
    };

    // 暂停下载
    document.getElementById('btn-pause-download').onclick = () => {
      chrome.runtime.sendMessage({ type: 'PAUSE_DOWNLOAD_BATCH' });
    };

    // 重试失败项
    document.getElementById('btn-retry-failed').onclick = () => {
      const failedItems = state.currentItems.filter(it => it.download_status === 'failed');
      if (failedItems.length === 0) {
        alert('当前没有下载失败的条目。');
        return;
      }
      failedItems.forEach(it => it.download_status = 'pending');
      const folderName = `X-Media/${state.currentTask.x_screen_name || 'unknown'}`;
      chrome.runtime.sendMessage({
        source: 'XMD_CONTENT',
        type: 'START_DOWNLOAD_BATCH',
        payload: {
          items: failedItems,
          folderName,
          concurrency: state.settings.concurrency || 4,
          taskId: state.currentTask.id
        }
      });
      renderDetailDashboard();
    };

    // 重新下载全部
    document.getElementById('btn-redownload-all').onclick = () => {
      if (!confirm('确定要将该任务中的所有媒体重新下载一遍吗？')) return;
      state.currentItems.forEach(it => it.download_status = 'pending');
      const folderName = `X-Media/${state.currentTask.x_screen_name || 'unknown'}`;
      chrome.runtime.sendMessage({
        source: 'XMD_CONTENT',
        type: 'START_DOWNLOAD_BATCH',
        payload: {
          items: state.currentItems,
          folderName,
          concurrency: state.settings.concurrency || 4,
          taskId: state.currentTask.id
        }
      });
      renderDetailDashboard();
    };

    // 打包所选为 ZIP
    document.getElementById('btn-export-zip').onclick = downloadSelectedAsZip;

    // 导出安卓移动端离线单页
    const exportMobileBtn = document.getElementById('btn-export-mobile');
    if (exportMobileBtn) exportMobileBtn.onclick = exportMobileViewer;

    // 导出/复制直链
    document.getElementById('btn-export-txt').onclick = exportSelectedUrlsTxt;

    // 删除任务
    document.getElementById('btn-delete-task').onclick = () => {
      if (!confirm(`确定要彻底删除该任务及其记录吗？\n博主: @${state.currentTask.x_screen_name}`)) return;
      chrome.runtime.sendMessage({ type: 'DELETE_TASK', payload: { taskId: state.currentTask.id } }, () => {
        switchView('tasks');
      });
    };
  }

  // --- 打包所选媒体为 ZIP ---
  async function downloadSelectedAsZip() {
    const selected = state.currentItems.filter(it => state.selectedIds.has(it.id));
    if (selected.length === 0) {
      alert('请先在下方勾选需要打包的图片或视频！');
      return;
    }

    if (!window.JSZip) {
      alert('JSZip 依赖库未就绪，请使用原生下载或直链导出。');
      return;
    }

    const zip = new window.JSZip();
    const handle = state.currentTask.x_screen_name || 'X_User';
    const folder = zip.folder(`${handle}_selected_media`);

    const btn = document.getElementById('btn-export-zip');
    const origText = btn.textContent;
    btn.disabled = true;

    let completed = 0;
    const total = selected.length;
    let idx = 0;

    async function worker() {
      while (idx < selected.length) {
        const i = idx++;
        const it = selected[i];
        const ext = it.mediaType === 'video' ? 'mp4' : 'jpg';
        const name = `${handle}_${it.tweetId}_${String(i + 1).padStart(3, '0')}.${ext}`;
        try {
          const resp = await fetch(it.mediaUrl);
          const blob = await resp.blob();
          folder.file(name, blob);
        } catch (e) {}
        completed++;
        btn.textContent = `打包中: ${completed}/${total}`;
      }
    }

    const workers = [];
    for (let w = 0; w < 3; w++) workers.push(worker());
    await Promise.all(workers);

    btn.textContent = '正在压缩生成 ZIP...';
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${handle}_selected_${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    btn.disabled = false;
    btn.textContent = origText;
  }

  function exportSelectedUrlsTxt() {
    const selected = state.currentItems.filter(it => state.selectedIds.has(it.id));
    if (selected.length === 0) {
      alert('请先在下方勾选需要导出的图片或视频！');
      return;
    }

    const urls = selected.map(it => it.mediaUrl).join('\n');
    const handle = state.currentTask.x_screen_name || 'X_User';

    navigator.clipboard.writeText(urls).then(() => {
      alert(`已将 ${selected.length} 个媒体直链复制到剪贴板！`);
    });

    const blob = new Blob([urls], { type: 'text/plain;charset=utf-8' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = `${handle}_urls_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(u);
  }

  // 实时下载进度回调
  function onDownloadProgressUpdate(payload) {
    if (!state.currentTask || payload.taskId !== state.currentTask.id) return;

    // 重新拉取一次当前任务详情并更新大屏
    loadTaskDetail(state.currentTask.id);
  }

  // =========================================================================
  // 3. Lightbox 播放器
  // =========================================================================
  function bindLightboxEvents() {
    document.getElementById('lightbox-close-btn').onclick = closeLightbox;
    document.getElementById('xmd-lightbox').onclick = (e) => {
      if (e.target.id === 'xmd-lightbox') closeLightbox();
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });
  }

  function openLightbox(item) {
    const box = document.getElementById('xmd-lightbox');
    const container = document.getElementById('lightbox-media-box');
    const dlBtn = document.getElementById('lightbox-dl-btn');
    const tweetInfo = document.getElementById('lightbox-tweet-info');
    const tweetTextEl = document.getElementById('lightbox-tweet-text');
    const tweetBtn = document.getElementById('lightbox-view-tweet-btn');

    container.innerHTML = '';

    if (item.mediaType === 'video') {
      const vid = document.createElement('video');
      vid.className = 'xmd-lightbox-media';
      vid.src = item.mediaUrl;
      vid.controls = true; vid.autoplay = true; vid.loop = true; vid.playsInline = true;
      container.appendChild(vid);
    } else {
      const img = document.createElement('img');
      img.className = 'xmd-lightbox-media';
      img.src = item.mediaUrl;
      container.appendChild(img);
    }

    // 原推文文本
    if (item.tweetText && item.tweetText.trim()) {
      tweetTextEl.textContent = item.tweetText;
      tweetInfo.style.display = 'block';
    } else {
      tweetInfo.style.display = 'none';
    }

    // 原推文直接跳转链接
    if (item.tweetId) {
      tweetBtn.href = `https://x.com/i/status/${item.tweetId}`;
      tweetBtn.style.display = 'inline-flex';
    } else {
      tweetBtn.style.display = 'none';
    }

    dlBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = item.mediaUrl;
      a.download = `${item.tweetId || 'media'}.${item.mediaType === 'video' ? 'mp4' : 'jpg'}`;
      a.target = '_blank';
      a.click();
    };

    box.classList.add('xmd-active');
  }

  function closeLightbox() {
    const box = document.getElementById('xmd-lightbox');
    const container = document.getElementById('lightbox-media-box');
    const tweetInfo = document.getElementById('lightbox-tweet-info');
    if (box) {
      box.classList.remove('xmd-active');
      if (container) {
        const v = container.querySelector('video');
        if (v) v.pause();
        container.innerHTML = '';
      }
      if (tweetInfo) {
        tweetInfo.style.display = 'none';
      }
    }
  }

  // =========================================================================
  // 4. 设置中心
  // =========================================================================
  async function loadSettings() {
    if (!isExtensionContext) return;
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (cfg) => {
      if (cfg) {
        state.settings = cfg;
        document.getElementById('setting-concurrency').value = cfg.concurrency || 4;
        document.getElementById('val-concurrency').textContent = cfg.concurrency || 4;
        document.getElementById('setting-folder').value = cfg.folderTemplate || 'X-Media/{username}';
        document.getElementById('setting-filename').value = cfg.filenameTemplate || '{username}_{tweet_id}_{index}';
        document.getElementById('setting-skip-rt').checked = cfg.skipRetweets ?? true;
      }
    });
  }

  function bindSettingsEvents() {
    const slider = document.getElementById('setting-concurrency');
    slider.oninput = () => {
      document.getElementById('val-concurrency').textContent = slider.value;
    };

    document.getElementById('btn-save-settings').onclick = () => {
      if (!isExtensionContext) {
        alert('手机端远程观看模式无需调整后台下载线程设置。');
        return;
      }
      const payload = {
        concurrency: parseInt(document.getElementById('setting-concurrency').value) || 4,
        folderTemplate: document.getElementById('setting-folder').value.trim() || 'X-Media/{username}',
        filenameTemplate: document.getElementById('setting-filename').value.trim() || '{username}_{tweet_id}_{index}',
        skipRetweets: document.getElementById('setting-skip-rt').checked
      };

      chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload }, () => {
        state.settings = payload;
        alert('配置已成功保存！');
      });
    };
  }

  // =========================================================================
  // 5. 安卓移动端离线阅读包生成与局域网远程连接
  // =========================================================================
  function bindRemoteHubEvents() {
    // 自动探测本地运行的 Python 远程服务器局域网 IP
    try {
      fetch('http://127.0.0.1:8080/api/lan_info')
        .then(r => r.json())
        .then(info => {
          if (info && info.ip) {
            const input = document.getElementById('remote-ip-input');
            if (input) input.value = info.ip;
            const targetUrl = `http://${info.ip}:${info.port || 8080}/dashboard.html`;
            const resBox = document.getElementById('remote-url-result');
            const linkEl = document.getElementById('remote-url-link');
            if (linkEl && resBox) {
              linkEl.href = targetUrl;
              linkEl.textContent = targetUrl;
              resBox.style.display = 'block';
            }
          }
        })
        .catch(() => {});
    } catch (e) {}

    const genBtn = document.getElementById('btn-generate-remote-url');
    if (genBtn) {
      genBtn.onclick = () => {
        const ip = (document.getElementById('remote-ip-input')?.value || '').trim();
        if (!ip) {
          alert('请先输入电脑在局域网中的 IP 地址（运行 start_remote_server.bat 即可查看）');
          return;
        }
        const port = 8080;
        const targetUrl = `http://${ip}:${port}/dashboard.html`;
        const resBox = document.getElementById('remote-url-result');
        const linkEl = document.getElementById('remote-url-link');
        if (linkEl && resBox) {
          linkEl.href = targetUrl;
          linkEl.textContent = targetUrl;
          resBox.style.display = 'block';
        }
      };
    }

    // 一键推送当前任务及任务库至手机远程服务
    const syncBtn = document.getElementById('btn-sync-to-remote');
    if (syncBtn) {
      syncBtn.onclick = async () => {
        const statusEl = document.getElementById('remote-sync-status');
        if (statusEl) {
          statusEl.style.display = 'block';
          statusEl.style.color = 'var(--text-main)';
          statusEl.textContent = '⏳ 正在推送任务至手机端服务...';
        }
        try {
          if (state.currentTask && state.currentItems && state.currentItems.length > 0) {
            await fetch('http://127.0.0.1:8080/api/sync_task', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ task: state.currentTask, items: state.currentItems })
            });
          }
          if (state.tasks && state.tasks.length > 0) {
            await fetch('http://127.0.0.1:8080/api/sync_all', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tasks: state.tasks })
            });
          }
          if (statusEl) {
            statusEl.style.color = 'var(--success)';
            statusEl.textContent = '✅ 推送成功！手机打开浏览器或扫码即可秒速观看！';
          }
        } catch (e) {
          if (statusEl) {
            statusEl.style.color = 'var(--error)';
            statusEl.textContent = '❌ 推送失败，请先双击运行 start_remote_server.bat 启动服务。';
          }
        }
      };
    }
  }

  // --- 静默同步辅助函数 ---
  async function syncSingleTaskToRemote(task, items) {
    if (!isExtensionContext || !task) return;
    try {
      await fetch('http://127.0.0.1:8080/api/sync_task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, items: items || [] })
      });
    } catch (e) {}
  }

  async function syncAllTasksToRemote() {
    if (!isExtensionContext || !state.tasks || state.tasks.length === 0) return;
    try {
      await fetch('http://127.0.0.1:8080/api/sync_all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: state.tasks })
      });
    } catch (e) {}
  }

  // --- 导出安卓移动端原生体验离线阅读单页 (HTML) ---
  function exportMobileViewer() {
    if (!state.currentTask || !state.currentItems || state.currentItems.length === 0) {
      alert('当前任务中没有可导出的推文媒体。');
      return;
    }

    const task = state.currentTask;
    const items = state.currentItems;
    const handle = task.x_screen_name || 'X_User';
    const name = task.x_name || task.task_name || handle;
    const avatar = task.x_avatar || '';
    const bio = task.x_description || '';

    // 按 tweetId 分组生成推文数据对象
    const tweetMap = new Map();
    for (const it of items) {
      const tid = it.tweetId || 'unknown';
      if (!tweetMap.has(tid)) {
        tweetMap.set(tid, {
          tweetId: tid,
          tweetText: it.tweetText || '',
          createdAt: it.createdAt || '',
          user: it.user || { name, screen_name: handle, avatar },
          media: []
        });
      }
      tweetMap.get(tid).media.push({
        id: it.id,
        mediaType: it.mediaType,
        mediaUrl: it.mediaUrl,
        thumbUrl: it.thumbUrl || it.mediaUrl,
        filename: `${handle}_${it.tweetId || 'media'}_${(it.id || '').slice(-4)}.${it.mediaType === 'video' ? 'mp4' : 'jpg'}`
      });
    }

    const tweetsArray = Array.from(tweetMap.values());
    const dataJson = JSON.stringify({
      task: { name, handle, avatar, bio, totalTweets: tweetsArray.length, totalMedia: items.length },
      tweets: tweetsArray
    }).replace(/<\/script>/g, '<\\/script>');

    const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapeHtml(name)} (@${escapeHtml(handle)}) - X 离线推文阅读器</title>
  <style>
    :root {
      --bg: #000000;
      --card-bg: #16181c;
      --border: #2f3336;
      --text: #e7e9ea;
      --text-muted: #71767b;
      --accent: #1d9bf0;
      --accent-hover: #1a8cd8;
      --success: #00ba7c;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding-bottom: 60px;
      -webkit-tap-highlight-color: transparent;
    }
    .header {
      position: sticky;
      top: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 100;
    }
    .profile-card {
      padding: 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 12px;
      background: var(--card-bg);
    }
    .avatar { width: 52px; height: 52px; border-radius: 50%; object-fit: cover; background: #2f3336; flex-shrink: 0; }
    .user-name { font-size: 17px; font-weight: 800; }
    .user-handle { font-size: 13px; color: var(--text-muted); margin-top: 2px; }
    .user-bio { font-size: 14px; color: var(--text); margin-top: 8px; line-height: 1.4; }
    .stats-row { display: flex; gap: 16px; margin-top: 10px; font-size: 13px; color: var(--text-muted); }
    .stats-row strong { color: var(--text); }
    .controls-bar {
      padding: 10px 16px;
      background: #111;
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .search-input {
      flex: 1;
      min-width: 140px;
      background: #202327;
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 6px 14px;
      color: #fff;
      font-size: 13px;
      outline: none;
    }
    .filter-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 16px;
      padding: 5px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    .filter-btn.active {
      background: #fff;
      color: #000;
      font-weight: 700;
      border-color: #fff;
    }
    .tweet-card {
      border-bottom: 1px solid var(--border);
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .tweet-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .tweet-author {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tweet-author-avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; }
    .tweet-author-meta { font-size: 13px; }
    .tweet-author-name { font-weight: 700; color: var(--text); }
    .tweet-author-handle { color: var(--text-muted); font-size: 12px; }
    .tweet-link {
      color: var(--accent);
      text-decoration: none;
      font-size: 12px;
      font-weight: 700;
      padding: 3px 8px;
      background: rgba(29, 155, 240, 0.1);
      border-radius: 4px;
    }
    .tweet-body {
      font-size: 15px;
      line-height: 1.5;
      color: var(--text);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .media-grid {
      display: grid;
      gap: 6px;
      border-radius: 12px;
      overflow: hidden;
      margin-top: 4px;
    }
    .grid-1 { grid-template-columns: 1fr; }
    .grid-2 { grid-template-columns: 1fr 1fr; }
    .grid-3 { grid-template-columns: 1fr 1fr; }
    .grid-4 { grid-template-columns: 1fr 1fr; }
    .media-item {
      position: relative;
      background: #202327;
      overflow: hidden;
      border-radius: 8px;
    }
    .media-img {
      width: 100%;
      height: 100%;
      max-height: 480px;
      object-fit: cover;
      display: block;
    }
    .media-video {
      width: 100%;
      max-height: 480px;
      background: #000;
      border-radius: 8px;
      display: block;
    }
    .tweet-date { font-size: 12px; color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="header">
    <div style="font-weight:800; font-size:16px;">📱 X 离线推文阅读器</div>
    <div style="font-size:12px; color:var(--success); font-weight:700;">● 离线就绪</div>
  </div>

  <div class="profile-card">
    <img class="avatar" src="${escapeHtml(avatar)}" onerror="this.style.display='none'" />
    <div style="flex:1;">
      <div class="user-name">${escapeHtml(name)}</div>
      <div class="user-handle">@${escapeHtml(handle)}</div>
      ${bio ? `<div class="user-bio">${escapeHtml(bio)}</div>` : ''}
      <div class="stats-row">
        <span>推文: <strong>${tweetsArray.length}</strong></span>
        <span>媒体: <strong>${items.length}</strong></span>
      </div>
    </div>
  </div>

  <div class="controls-bar">
    <input type="text" id="searchInput" class="search-input" placeholder="🔍 搜索推文正文内容..." />
    <button class="filter-btn active" data-filter="all">全部</button>
    <button class="filter-btn" data-filter="image">图片</button>
    <button class="filter-btn" data-filter="video">视频</button>
  </div>

  <div id="tweetsContainer"></div>

  <script>
    const DATA = ${dataJson};
    let activeFilter = 'all';
    let searchQuery = '';

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function render() {
      const container = document.getElementById('tweetsContainer');
      container.innerHTML = '';

      let list = DATA.tweets;
      if (activeFilter === 'image') {
        list = list.filter(t => t.media.some(m => m.mediaType === 'image'));
      } else if (activeFilter === 'video') {
        list = list.filter(t => t.media.some(m => m.mediaType === 'video'));
      }

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        list = list.filter(t => (t.tweetText || '').toLowerCase().includes(q));
      }

      if (list.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:40px; color:#71767b; font-size:14px;">没有匹配的推文</div>';
        return;
      }

      for (const t of list) {
        const card = document.createElement('div');
        card.className = 'tweet-card';

        const tweetUrl = t.tweetId && t.tweetId !== 'unknown' ? 'https://x.com/i/status/' + t.tweetId : '';
        const author = t.user || DATA.task;

        let dateStr = '';
        if (t.createdAt) {
          try {
            const d = new Date(t.createdAt);
            dateStr = (d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
          } catch(e) {}
        }

        let mediaHtml = '';
        if (t.media && t.media.length > 0) {
          const gridClass = 'grid-' + Math.min(4, t.media.length);
          mediaHtml = '<div class="media-grid ' + gridClass + '">';
          for (const m of t.media) {
            if (m.mediaType === 'video') {
              mediaHtml += '<div class="media-item"><video class="media-video" src="' + m.mediaUrl + '" poster="' + m.thumbUrl + '" controls playsinline preload="metadata"></video></div>';
            } else {
              mediaHtml += '<div class="media-item"><img class="media-img" src="' + m.mediaUrl + '" loading="lazy" /></div>';
            }
          }
          mediaHtml += '</div>';
        }

        card.innerHTML = \`
          <div class="tweet-header">
            <div class="tweet-author">
              <img class="tweet-author-avatar" src="\${escapeHtml(author.avatar || '')}" onerror="this.style.display='none'" />
              <div class="tweet-author-meta">
                <span class="tweet-author-name">\${escapeHtml(author.name || DATA.task.name)}</span>
                <span class="tweet-author-handle">@\${escapeHtml(author.screen_name || DATA.task.handle)}</span>
              </div>
            </div>
            \${tweetUrl ? '<a href="' + tweetUrl + '" target="_blank" class="tweet-link">在 X 查看 ↗</a>' : ''}
          </div>
          \${t.tweetText ? '<div class="tweet-body">' + escapeHtml(t.tweetText) + '</div>' : ''}
          \${mediaHtml}
          \${dateStr ? '<div class="tweet-date">' + dateStr + '</div>' : ''}
        \`;

        container.appendChild(card);
      }
    }

    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.getAttribute('data-filter');
        render();
      };
    });

    document.getElementById('searchInput').oninput = (e) => {
      searchQuery = e.target.value.trim();
      render();
    };

    render();
  </script>
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = `X_${handle}_mobile_offline_${Date.now()}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(u);
    alert(`🎉 移动端离线阅读包生成成功！\n文件: X_${handle}_mobile_offline.html\n\n你可以直接将此 HTML 文件发送到安卓手机（微信、QQ、数据线拷贝），在手机任何浏览器中直接打开即可离线刷推！`);
  }

})();
