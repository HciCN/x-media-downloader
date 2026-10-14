/**
 * X-Media-Downloader - Dashboard Controller (SPA)
 * 仿 Plucker XBD 核心任务工作台：任务持久化查看、大屏进度追踪、
 * 细粒度媒体勾选、ZIP 打包、断点并发下载与全局配置
 */

(function () {
  'use strict';

  // 全局页面状态
  const state = {
    currentView: 'tasks', // 'tasks', 'detail', 'settings'
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

    // 检查 URL 是否带 task ID
    const urlParams = new URLSearchParams(window.location.search);
    const taskId = urlParams.get('id');

    await loadSettings();

    if (taskId) {
      await loadTaskDetail(taskId);
    } else {
      await loadTaskList();
    }

    // 监听来自后台的实时下载进度
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.source === 'XMD_BG' && msg.type === 'DOWNLOAD_PROGRESS') {
        onDownloadProgressUpdate(msg.payload);
      }
    });
  });

  // --- 导航与视图切换 ---
  function bindNavigation() {
    document.getElementById('nav-brand-btn').onclick = (e) => {
      e.preventDefault();
      switchView('tasks');
    };

    document.getElementById('tab-btn-tasks').onclick = () => switchView('tasks');
    document.getElementById('tab-btn-detail').onclick = () => switchView('detail');
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
    } else if (viewName === 'settings') {
      document.getElementById('view-settings').classList.add('active');
      document.getElementById('tab-btn-settings').classList.add('active');
    }
  }

  // =========================================================================
  // 1. 任务列表视图逻辑
  // =========================================================================
  async function loadTaskList() {
    chrome.runtime.sendMessage({ type: 'GET_TASK_LIST' }, (res) => {
      if (res && res.success) {
        state.tasks = res.tasks || [];
        renderTaskList();
      }
    });
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
            <img class="task-card-avatar" src="${t.x_avatar || ''}" onerror="this.style.display='none'" />
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
    chrome.runtime.sendMessage({ type: 'GET_TASK_DETAIL', payload: { taskId } }, (res) => {
      if (res && res.success) {
        state.currentTask = res.task;
        state.currentItems = res.items || [];
        state.selectedIds.clear();
        // 默认全选
        state.currentItems.forEach(it => state.selectedIds.add(it.id));

        renderDetailDashboard();
        switchView('detail');
      } else {
        alert('加载任务详情失败: ' + (res?.error || '未知错误'));
      }
    });
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
    renderMediaWaterfall();
  }

  function updateSelectedCountUI() {
    document.getElementById('selected-items-count').textContent = state.selectedIds.size;
  }

  // 渲染媒体瀑布流画廊
  function renderMediaWaterfall() {
    const grid = document.getElementById('media-waterfall-grid');
    grid.innerHTML = '';

    let filtered = state.currentItems;
    if (state.activeFilter === 'image') filtered = filtered.filter(it => it.mediaType === 'image');
    else if (state.activeFilter === 'video') filtered = filtered.filter(it => it.mediaType === 'video');
    else if (state.activeFilter === 'failed') filtered = filtered.filter(it => it.download_status === 'failed');

    filtered.forEach(it => {
      const itemEl = document.createElement('div');
      itemEl.className = 'gallery-item' + (state.selectedIds.has(it.id) ? ' selected' : '');

      const isChecked = state.selectedIds.has(it.id);
      const dotClass = it.download_status === 'completed' ? 'dot-completed' :
                       it.download_status === 'failed' ? 'dot-failed' : 'dot-pending';

      itemEl.innerHTML = `
        <input type="checkbox" class="gallery-checkbox" ${isChecked ? 'checked' : ''} />
        <span class="gallery-status-dot ${dotClass}" title="状态: ${it.download_status}"></span>
        <img class="gallery-thumb-img" src="${it.thumbUrl || it.mediaUrl}" loading="lazy" />
        <span class="gallery-badge">${it.mediaType === 'video' ? 'MP4' : 'IMG'}</span>
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

      // 点击打开 Lightbox 播放/查看
      itemEl.onclick = () => {
        openLightbox(it);
      };

      grid.appendChild(itemEl);
    });
  }

  // 绑定控制按钮事件
  function bindDetailActions() {
    // 筛选标签
    document.querySelectorAll('.gallery-filters .filter-pill').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.gallery-filters .filter-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.activeFilter = btn.getAttribute('data-filter');
        renderMediaWaterfall();
      };
    });

    // 全选/全不选/反选
    document.getElementById('btn-select-all').onclick = () => {
      state.currentItems.forEach(it => state.selectedIds.add(it.id));
      updateSelectedCountUI();
      renderMediaWaterfall();
    };

    document.getElementById('btn-select-none').onclick = () => {
      state.selectedIds.clear();
      updateSelectedCountUI();
      renderMediaWaterfall();
    };

    document.getElementById('btn-select-invert').onclick = () => {
      state.currentItems.forEach(it => {
        if (state.selectedIds.has(it.id)) state.selectedIds.delete(it.id);
        else state.selectedIds.add(it.id);
      });
      updateSelectedCountUI();
      renderMediaWaterfall();
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
    if (box) {
      box.classList.remove('xmd-active');
      if (container) {
        const v = container.querySelector('video');
        if (v) v.pause();
        container.innerHTML = '';
      }
    }
  }

  // =========================================================================
  // 4. 设置中心
  // =========================================================================
  async function loadSettings() {
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

})();
