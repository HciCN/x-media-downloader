/**
 * X-Media-Downloader - Content Script
 * 负责注入主世界 Hook、构建并管理悬浮控制面板、可拖拽悬浮球、内置视频播放器、
 * 信息流推文一键下载按钮注入、媒体多选精准打包、与总控制台 (Dashboard) 联动
 */

(function () {
  'use strict';

  console.log('[XMD] Content script injected on', window.location.href);

  // 1. 注入 injected.js 到页面的主世界 (Main World)
  function injectMainWorldScript() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('injected.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.warn('[XMD] Failed to inject injected.js:', e);
    }
  }
  injectMainWorldScript();

  // 2. 全局状态
  const state = {
    userProfile: {
      name: '',
      screen_name: '',
      avatar: '',
      rest_id: ''
    },
    capturedItems: new Map(), // key: url -> item
    tweetItemsMap: new Map(), // tweetId -> [items]
    tweetMetaMap: new Map(),  // tweetId -> { tweetText, createdAt, isRetweet, user }
    selectedIds: new Set(),   // 已勾选的媒体 URL 集合
    batchCount: 0,            // 已截获批次数
    viewMode: 'grid',         // 'grid' | 'tweets'
    queryConfig: null,
    headers: {},
    nextCursor: null,
    isScraping: false,
    isPaused: false,
    scrapeMode: 'api',
    limitCount: 0,
    filterType: 'all',
    skipRetweets: true,
    pageCount: 0,
    chunkCount: 0,
    rawTweetCount: 0,
    requestIdSeed: 0
  };

  function getAdaptiveDelay(page) {
    if (page < 5) return 800 + Math.random() * 800;
    if (page < 10) return 1500 + Math.random() * 1000;
    if (page < 20) return 3000 + Math.random() * 2000;
    if (page < 50) return 5000 + Math.random() * 3000;
    return 10000 + Math.random() * 8000;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function detectCurrentHandle() {
    if (state.userProfile?.screen_name) return state.userProfile.screen_name;
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length > 0 && !['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i'].includes(parts[0].toLowerCase())) {
      return parts[0].replace('@', '');
    }
    const titleMatch = document.title.match(/\(@([a-zA-Z0-9_]+)\)/);
    if (titleMatch) return titleMatch[1];
    return '';
  }

  // 3. 构建悬浮控制面板 & 拖拽 & Lightbox
  function createUI() {
    if (document.getElementById('xmd-float-trigger')) return;

    // 悬浮球
    const trigger = document.createElement('div');
    trigger.id = 'xmd-float-trigger';
    trigger.title = '长按可拖动 | 点击打开 X/Twitter 批量媒体下载器';
    trigger.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
      </svg>
      <div id="xmd-float-badge">0</div>
    `;

    const savedPos = localStorage.getItem('xmd_trigger_pos');
    if (savedPos) {
      try {
        const { left, top } = JSON.parse(savedPos);
        trigger.style.left = `${Math.max(10, Math.min(window.innerWidth - 64, left))}px`;
        trigger.style.top = `${Math.max(10, Math.min(window.innerHeight - 64, top))}px`;
        trigger.style.right = 'auto';
        trigger.style.bottom = 'auto';
      } catch (e) {}
    }

    // 控制面板
    const panel = document.createElement('div');
    panel.id = 'xmd-panel';
    panel.className = 'xmd-hidden';
    panel.innerHTML = `
      <div class="xmd-header">
        <div class="xmd-user-info">
          <img id="xmd-avatar" class="xmd-avatar" src="" alt="avatar" style="display:none;" />
          <div class="xmd-user-names">
            <div id="xmd-name" class="xmd-name">准备就绪</div>
            <div id="xmd-handle" class="xmd-handle">@${detectCurrentHandle() || 'X-User'}</div>
          </div>
        </div>
        <div class="xmd-header-actions">
          <button id="xmd-btn-open-dashboard" class="btn btn-secondary" style="padding:4px 10px; font-size:11px;" title="进入独立大屏 Web 总控制台">
            总控台 ↗
          </button>
          <button id="xmd-btn-close" class="xmd-btn-icon" title="关闭面板">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>

      <div class="xmd-body">
        <div class="xmd-stats-grid">
          <div class="xmd-stat-card">
            <div id="xmd-stat-total" class="xmd-stat-num accent">0</div>
            <div class="xmd-stat-label">总媒体数</div>
          </div>
          <div class="xmd-stat-card">
            <div id="xmd-stat-images" class="xmd-stat-num success">0</div>
            <div class="xmd-stat-label">高清图片</div>
          </div>
          <div class="xmd-stat-card">
            <div id="xmd-stat-videos" class="xmd-stat-num warning">0</div>
            <div class="xmd-stat-label">最高码率视频</div>
          </div>
        </div>

        <div class="xmd-progress-wrap">
          <div class="xmd-progress-info">
            <span id="xmd-status-label">就绪，可开始抓取</span>
            <span id="xmd-page-info">第 0 页</span>
          </div>
          <div class="xmd-progress-bar-bg">
            <div id="xmd-progress-fill" class="xmd-progress-bar-fill"></div>
          </div>
          <div id="xmd-status-hint" class="xmd-status-text"></div>
        </div>

        <div class="xmd-options-wrap">
          <div class="xmd-section-title" style="display:flex; justify-content:space-between; align-items:center;">
            <span>GraphQL 游标分块配置 (Cursor Chunking)</span>
            <span class="xmd-cursor-badge" id="xmd-cursor-badge" title="当前游标状态">游标: 初始</span>
          </div>
          <div class="xmd-options-row">
            <select id="xmd-opt-chunk-limit" class="xmd-select" style="flex:1.4;">
              <option value="1">⚡ 抓取 1 个分块 (1 Chunk / 20条推文)</option>
              <option value="5">📦 抓取 5 个分块 (5 Chunks / 约100条推文)</option>
              <option value="10" selected>🚀 抓取 10 个分块 (10 Chunks / 约200条推文)</option>
              <option value="25">🔥 抓取 25 个分块 (25 Chunks / 约500条推文)</option>
              <option value="0">♾️ 持续连续分块 (直到时间线终点)</option>
            </select>
            <select id="xmd-opt-type" class="xmd-select" style="flex:1;">
              <option value="all">图片 + 视频</option>
              <option value="image">仅高清图片</option>
              <option value="video">仅视频 / GIF</option>
            </select>
          </div>
          <div class="xmd-checkbox-row" style="margin-top: 10px; display:flex; align-items:center;">
            <label class="xmd-checkbox-label">
              <input type="checkbox" id="xmd-opt-skip-rt" checked /> 跳过转推 (RT)
            </label>
            <span id="xmd-chunk-stats" class="xmd-chunk-stats">
              已推进: <strong>0</strong> 块 / 累计推文: <strong>~0</strong>
            </span>
          </div>
        </div>

        <div class="xmd-btn-group">
          <button id="xmd-btn-chunk-step" class="xmd-btn-chunk-step" title="单步拉取下 1 个分块 (20条推文) 并推进游标">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M5 13l4 4L19 7"/>
            </svg>
            单块步进 (+20推)
          </button>
          <button id="xmd-btn-start" class="xmd-btn xmd-btn-primary" style="flex: 2;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            开始分块抓取 (Chunking)
          </button>
          <button id="xmd-btn-pause" class="xmd-btn xmd-btn-secondary" disabled>暂停</button>
          <button id="xmd-btn-reset" class="xmd-btn xmd-btn-danger">清空重置</button>
        </div>

        <div class="xmd-section-title">下载与导出</div>
        <div class="xmd-export-grid">
          <button id="xmd-btn-zip" class="xmd-btn xmd-btn-success" disabled>
            打包所选为 ZIP
          </button>
          <button id="xmd-btn-native-dl" class="xmd-btn xmd-btn-secondary" disabled>
            下载所选 (原生)
          </button>
          <button id="xmd-btn-export-txt" class="xmd-btn xmd-btn-secondary" disabled>
            复制所选直链 (TXT)
          </button>
          <button id="xmd-btn-archive-task" class="xmd-btn xmd-btn-secondary" disabled>
            归档至总控台 ↗
          </button>
        </div>

        <!-- 总控制台直达看板卡片 (侧边栏预览已完全转入大屏总控制台) -->
        <div class="xmd-dashboard-portal-card">
          <div class="xmd-portal-header">
            <span class="xmd-portal-title">全量媒体大屏与推文直达</span>
            <span id="xmd-batch-count-badge" class="xmd-batch-pill" style="display:none;">0 批</span>
          </div>
          <p class="xmd-portal-desc">
            为保证页面轻量无卡顿，媒体预览已全部迁移至独立 Web 总控制台。支持大屏画廊、<strong>推文链接直达原推</strong>、断点并发下载与一键打包。
          </p>
          <button id="xmd-btn-open-dashboard-card" class="xmd-btn xmd-btn-primary" style="width: 100%; justify-content: center; padding: 10px 14px; margin-top: 6px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
            </svg>
            进入 Web 总控制台预览与查看原推 (<span id="xmd-portal-count">0</span>) ↗
          </button>
        </div>
      </div>
    `;

    // Lightbox 内置预览播放器弹窗
    const lightbox = document.createElement('div');
    lightbox.id = 'xmd-lightbox';
    lightbox.innerHTML = `
      <button class="xmd-lightbox-close" id="xmd-lightbox-close">✕</button>
      <div class="xmd-lightbox-content">
        <div id="xmd-lightbox-media-container"></div>
        <div class="xmd-lightbox-bar">
          <button class="xmd-lightbox-btn" id="xmd-lightbox-dl-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
            </svg>
            立即下载该媒体
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(trigger);
    document.body.appendChild(panel);
    document.body.appendChild(lightbox);

    // 绑定悬浮球拖拽逻辑
    makeDraggable(trigger, () => {
      panel.classList.toggle('xmd-hidden');
    });

    document.getElementById('xmd-btn-close').onclick = () => {
      panel.classList.add('xmd-hidden');
    };

    document.getElementById('xmd-btn-open-dashboard').onclick = () => {
      archiveTaskToDashboard(true);
    };

    document.getElementById('xmd-btn-open-dashboard-card').onclick = () => {
      archiveTaskToDashboard(true);
    };

    document.getElementById('xmd-lightbox-close').onclick = closeLightbox;
    lightbox.onclick = (e) => {
      if (e.target === lightbox) closeLightbox();
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });

    document.getElementById('xmd-btn-chunk-step').onclick = stepSingleChunk;
    document.getElementById('xmd-btn-start').onclick = startChunkingLoop;
    document.getElementById('xmd-btn-pause').onclick = togglePause;
    document.getElementById('xmd-btn-reset').onclick = resetData;

    document.getElementById('xmd-btn-zip').onclick = downloadSelectedAsZip;
    document.getElementById('xmd-btn-native-dl').onclick = downloadSelectedNative;
    document.getElementById('xmd-btn-export-txt').onclick = exportSelectedTxt;
    document.getElementById('xmd-btn-archive-task').onclick = archiveTaskToDashboard;
  }

  // 悬浮球自由拖拽与点击判定实现
  function makeDraggable(el, onClickCallback) {
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;
    let hasMoved = false;

    function onPointerDown(e) {
      if (e.button !== 0 && e.type !== 'touchstart') return;
      isDragging = true;
      hasMoved = false;

      const clientX = e.clientX ?? e.touches[0].clientX;
      const clientY = e.clientY ?? e.touches[0].clientY;
      startX = clientX;
      startY = clientY;

      const rect = el.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      el.classList.add('xmd-dragging');
      document.addEventListener('mousemove', onPointerMove);
      document.addEventListener('touchmove', onPointerMove, { passive: false });
      document.addEventListener('mouseup', onPointerUp);
      document.addEventListener('touchend', onPointerUp);
    }

    function onPointerMove(e) {
      if (!isDragging) return;
      const clientX = e.clientX ?? (e.touches ? e.touches[0].clientX : startX);
      const clientY = e.clientY ?? (e.touches ? e.touches[0].clientY : startY);

      const dx = clientX - startX;
      const dy = clientY - startY;

      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        hasMoved = true;
      }

      if (hasMoved) {
        if (e.cancelable) e.preventDefault();
        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        const maxLeft = window.innerWidth - el.offsetWidth - 10;
        const maxTop = window.innerHeight - el.offsetHeight - 10;
        newLeft = Math.max(10, Math.min(maxLeft, newLeft));
        newTop = Math.max(10, Math.min(maxTop, newTop));

        el.style.left = `${newLeft}px`;
        el.style.top = `${newTop}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      }
    }

    function onPointerUp() {
      if (!isDragging) return;
      isDragging = false;
      el.classList.remove('xmd-dragging');

      document.removeEventListener('mousemove', onPointerMove);
      document.removeEventListener('touchmove', onPointerMove);
      document.removeEventListener('mouseup', onPointerUp);
      document.removeEventListener('touchend', onPointerUp);

      if (hasMoved) {
        const rect = el.getBoundingClientRect();
        localStorage.setItem('xmd_trigger_pos', JSON.stringify({ left: rect.left, top: rect.top }));
      } else {
        onClickCallback?.();
      }
    }

    el.addEventListener('mousedown', onPointerDown);
    el.addEventListener('touchstart', onPointerDown, { passive: false });
  }

  // Lightbox 播放器控制
  function openLightbox(item) {
    const box = document.getElementById('xmd-lightbox');
    const container = document.getElementById('xmd-lightbox-media-container');
    const dlBtn = document.getElementById('xmd-lightbox-dl-btn');
    if (!box || !container) return;

    container.innerHTML = '';

    if (item.mediaType === 'video') {
      const video = document.createElement('video');
      video.className = 'xmd-lightbox-media';
      video.src = item.mediaUrl;
      video.controls = true;
      video.autoplay = true;
      video.loop = true;
      video.playsInline = true;
      container.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.className = 'xmd-lightbox-media';
      img.src = item.mediaUrl;
      container.appendChild(img);
    }

    dlBtn.onclick = () => {
      downloadSingleMedia(item);
    };

    box.classList.add('xmd-active');
  }

  function closeLightbox() {
    const box = document.getElementById('xmd-lightbox');
    const container = document.getElementById('xmd-lightbox-media-container');
    if (box) {
      box.classList.remove('xmd-active');
      if (container) {
        const vid = container.querySelector('video');
        if (vid) vid.pause();
        container.innerHTML = '';
      }
    }
  }

  // 4. 监听来自 Injected Script 的消息
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'XMD_INJECTED') return;

    const { type, payload } = ev.data;

    if (type === 'QUERY_CONFIG_SNIFFED') {
      if (payload.queryName === 'UserMedia' || payload.queryName === 'UserTweets') {
        state.queryConfig = payload.config;
      }
      Object.assign(state.headers, payload.headers);
    }

    if (type === 'RESPONSE_SNIFFED') {
      if (payload.profile) updateProfileUI(payload.profile);
      if (payload.nextCursor) state.nextCursor = payload.nextCursor;
      if (payload.items && payload.items.length > 0) addMediaItems(payload.items);
    }
  });

  function updateProfileUI(profile) {
    if (!profile) return;
    Object.assign(state.userProfile, profile);
    const nameEl = document.getElementById('xmd-name');
    const handleEl = document.getElementById('xmd-handle');
    const avatarEl = document.getElementById('xmd-avatar');

    if (nameEl && profile.name) nameEl.textContent = profile.name;
    if (handleEl && profile.screen_name) handleEl.textContent = `@${profile.screen_name}`;
    if (avatarEl && profile.avatar) {
      avatarEl.src = profile.avatar;
      avatarEl.style.display = 'block';
    }
  }

  function showBatchIncrementBubble(count) {
    const trigger = document.getElementById('xmd-float-trigger');
    if (!trigger || count <= 0) return;
    const bubble = document.createElement('div');
    bubble.className = 'xmd-float-bubble';
    bubble.textContent = `+${count} 媒体`;
    trigger.appendChild(bubble);
    setTimeout(() => bubble.remove(), 2200);
  }

  function addMediaItems(items) {
    const skipRt = document.getElementById('xmd-opt-skip-rt')?.checked ?? true;
    const typeFilter = document.getElementById('xmd-opt-type')?.value ?? 'all';

    const newItems = [];
    const affectedTweetIds = new Set();

    for (const item of items) {
      if (item.tweetId) {
        if (!state.tweetItemsMap.has(item.tweetId)) {
          state.tweetItemsMap.set(item.tweetId, []);
        }
        const list = state.tweetItemsMap.get(item.tweetId);
        if (!list.some(x => x.mediaUrl === item.mediaUrl)) {
          list.push(item);
        }
        if (!state.tweetMetaMap.has(item.tweetId)) {
          state.tweetMetaMap.set(item.tweetId, {
            tweetId: item.tweetId,
            tweetText: item.tweetText,
            createdAt: item.createdAt,
            isRetweet: item.isRetweet,
            user: item.user
          });
        }
      }

      if (skipRt && item.isRetweet) continue;
      if (typeFilter === 'image' && item.mediaType !== 'image') continue;
      if (typeFilter === 'video' && item.mediaType !== 'video') continue;

      const key = item.mediaUrl;
      if (!state.capturedItems.has(key)) {
        state.capturedItems.set(key, item);
        state.selectedIds.add(key); // 新增条目默认勾选
        newItems.push(item);
        if (item.tweetId) affectedTweetIds.add(item.tweetId);
      }
    }

    if (newItems.length > 0) {
      state.batchCount++;
      showBatchIncrementBubble(newItems.length);

      // 更新批次 badge
      const batchBadge = document.getElementById('xmd-batch-count-badge');
      if (batchBadge) {
        batchBadge.style.display = 'inline-block';
        batchBadge.textContent = `${state.batchCount} 批`;
      }

      const hintEl = document.getElementById('xmd-status-hint');
      if (hintEl && !state.isScraping) {
        hintEl.textContent = `⚡ 触底截获第 ${state.batchCount} 批数据 (+${newItems.length} 媒体) | 累计: ${state.capturedItems.size} 个`;
      }
    }

    updateStatsUI();
  }

  function updateStatsUI() {
    let imgCount = 0;
    let vidCount = 0;
    for (const item of state.capturedItems.values()) {
      if (item.mediaType === 'video') vidCount++;
      else imgCount++;
    }

    const total = state.capturedItems.size;
    const badge = document.getElementById('xmd-float-badge');
    const totalEl = document.getElementById('xmd-stat-total');
    const imgEl = document.getElementById('xmd-stat-images');
    const vidEl = document.getElementById('xmd-stat-videos');
    const portalCount = document.getElementById('xmd-portal-count');

    if (badge) {
      badge.textContent = total > 999 ? '999+' : total;
      badge.style.display = total > 0 ? 'block' : 'none';
    }
    if (totalEl) totalEl.textContent = total;
    if (imgEl) imgEl.textContent = imgCount;
    if (vidEl) vidEl.textContent = vidCount;
    if (portalCount) portalCount.textContent = total;

    updateSelectionCounts();

    const hasItems = total > 0;
    ['xmd-btn-zip', 'xmd-btn-native-dl', 'xmd-btn-export-txt', 'xmd-btn-archive-task'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = !hasItems;
    });
  }

  function updateSelectionCounts() {
    const selCount = state.selectedIds.size;
    const countEl = document.getElementById('xmd-selected-count');
    if (countEl) countEl.textContent = selCount;

    const zipBtn = document.getElementById('xmd-btn-zip');
    const dlBtn = document.getElementById('xmd-btn-native-dl');
    const txtBtn = document.getElementById('xmd-btn-export-txt');

    if (zipBtn) zipBtn.textContent = `打包所选为 ZIP (${selCount})`;
    if (dlBtn) dlBtn.textContent = `下载所选 (${selCount})`;
    if (txtBtn) txtBtn.textContent = `复制所选直链 (${selCount})`;
  }

  function syncAllCheckboxes() {
    document.querySelectorAll('.xmd-thumb-item').forEach(el => {
      const url = el.getAttribute('data-url');
      const cb = el.querySelector('.xmd-thumb-checkbox');
      const isSel = state.selectedIds.has(url);
      if (cb) cb.checked = isSel;
      if (isSel) el.classList.add('selected');
      else el.classList.remove('selected');
    });
  }

  function selectAll() {
    for (const url of state.capturedItems.keys()) {
      state.selectedIds.add(url);
    }
    syncAllCheckboxes();
    updateSelectionCounts();
  }

  function selectNone() {
    state.selectedIds.clear();
    syncAllCheckboxes();
    updateSelectionCounts();
  }

  function selectInvert() {
    for (const url of state.capturedItems.keys()) {
      if (state.selectedIds.has(url)) state.selectedIds.delete(url);
      else state.selectedIds.add(url);
    }
    syncAllCheckboxes();
    updateSelectionCounts();
  }

  function createThumbElement(item) {
    const div = document.createElement('div');
    const isSelected = state.selectedIds.has(item.mediaUrl);
    div.className = `xmd-thumb-item ${isSelected ? 'selected' : ''}`;
    div.setAttribute('data-url', item.mediaUrl);
    div.title = `点击在线预览 (${item.mediaType})\n${item.tweetText || ''}`;

    div.innerHTML = `
      <input type="checkbox" class="xmd-thumb-checkbox" ${isSelected ? 'checked' : ''} />
      <img class="xmd-thumb-img" src="${item.thumbUrl || item.mediaUrl}" loading="lazy" />
      <span class="xmd-thumb-badge">${item.mediaType === 'video' ? 'MP4' : 'IMG'}</span>
    `;

    const cb = div.querySelector('.xmd-thumb-checkbox');
    cb.onclick = (e) => {
      e.stopPropagation();
      if (cb.checked) {
        state.selectedIds.add(item.mediaUrl);
        div.classList.add('selected');
      } else {
        state.selectedIds.delete(item.mediaUrl);
        div.classList.remove('selected');
      }
      updateSelectionCounts();
    };

    div.onclick = (e) => {
      if (e.target === cb) return;
      openLightbox(item);
    };
    return div;
  }

  function appendBatchToGallery(items) {
    const grid = document.getElementById('xmd-gallery-grid');
    if (!grid) return;
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      fragment.appendChild(createThumbElement(item));
    }
    grid.appendChild(fragment);
  }

  function updateTweetCards(tweetIds) {
    const container = document.getElementById('xmd-tweets-container');
    if (!container) return;

    for (const tweetId of tweetIds) {
      let card = container.querySelector(`[data-tweet-id="${tweetId}"]`);
      const items = (state.tweetItemsMap.get(tweetId) || []).filter(it => state.capturedItems.has(it.mediaUrl));
      if (items.length === 0) {
        if (card) card.remove();
        continue;
      }

      const meta = state.tweetMetaMap.get(tweetId) || {};

      if (!card) {
        card = document.createElement('div');
        card.className = 'xmd-tweet-group-card';
        card.setAttribute('data-tweet-id', tweetId);
        container.appendChild(card);
      }

      let dateStr = '';
      if (meta.createdAt) {
        try {
          const d = new Date(meta.createdAt);
          dateStr = `${d.getMonth() + 1}-${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        } catch (e) {}
      }

      card.innerHTML = `
        <div class="xmd-tweet-group-header">
          <span>推文 ID: ${tweetId}</span>
          <span>${dateStr}</span>
        </div>
        <div class="xmd-tweet-group-text">${meta.tweetText || '（无推文文本）'}</div>
        <div class="xmd-tweet-group-grid" id="xmd-tweet-grid-${tweetId}"></div>
        <div class="xmd-tweet-group-footer">
          <span>包含 <strong>${items.length}</strong> 个媒体</span>
          <button class="xmd-tweet-group-dl-btn">一键下载本推媒体 (${items.length})</button>
        </div>
      `;

      const gridEl = card.querySelector(`#xmd-tweet-grid-${tweetId}`);
      for (const it of items) {
        gridEl.appendChild(createThumbElement(it));
      }

      card.querySelector('.xmd-tweet-group-dl-btn').onclick = (e) => {
        e.stopPropagation();
        items.forEach(it => downloadSingleMedia(it));
      };
    }
  }

  function toggleViewMode(mode) {
    state.viewMode = mode;
    const grid = document.getElementById('xmd-gallery-grid');
    const tweetsCont = document.getElementById('xmd-tweets-container');
    if (!grid || !tweetsCont) return;

    if (mode === 'tweets') {
      grid.style.display = 'none';
      tweetsCont.style.display = 'flex';
      updateTweetCards(Array.from(state.tweetItemsMap.keys()));
    } else {
      tweetsCont.style.display = 'none';
      grid.style.display = 'grid';
    }
  }

  // 5. GraphQL 游标分块核心引擎 (Cursor Chunking Engine)
  // Twitter 官方接口基于游标分块设计，每次请求默认下发 20 条推文作为一个完整数据包
  async function fetchSingleChunk() {
    const hintEl = document.getElementById('xmd-status-hint');
    const badgeEl = document.getElementById('xmd-cursor-badge');
    const statsEl = document.getElementById('xmd-chunk-stats');
    const pageEl = document.getElementById('xmd-page-info');

    if (!state.queryConfig) {
      if (hintEl) hintEl.textContent = '正在获取 Twitter GraphQL 接口模板，请稍候...';
      window.scrollBy({ top: 600, behavior: 'smooth' });
      await sleep(1200);
    }

    const requestId = ++state.requestIdSeed;
    const variables = {
      ...(state.queryConfig?.variables || {}),
      count: 20
    };
    if (state.nextCursor) {
      variables.cursor = state.nextCursor;
    }

    if (hintEl) hintEl.textContent = `⚡ 正在请求第 ${state.chunkCount + 1} 个游标分块 (Cursor Chunk: 20条推文)...`;

    const fetchPromise = new Promise((resolve) => {
      const handler = (ev) => {
        if (ev.source !== window || !ev.data || ev.data.source !== 'XMD_INJECTED') return;
        if (ev.data.type === 'EXECUTE_GRAPHQL_FETCH_REPLY' && ev.data.requestId === requestId) {
          window.removeEventListener('message', handler);
          resolve(ev.data);
        }
      };
      window.addEventListener('message', handler);
    });

    window.postMessage({
      source: 'XMD_CONTENT',
      type: 'EXECUTE_GRAPHQL_FETCH',
      requestId,
      payload: {
        endpointUrl: state.queryConfig?.urlTemplate,
        variables,
        features: state.queryConfig?.features,
        fieldToggles: state.queryConfig?.fieldToggles
      }
    }, '*');

    const reply = await fetchPromise;

    if (reply && reply.success && reply.data) {
      const { items, nextCursor, profile } = reply.data;
      if (profile) updateProfileUI(profile);

      state.chunkCount++;
      state.rawTweetCount += 20;

      const prevCount = state.capturedItems.size;
      if (items && items.length > 0) {
        addMediaItems(items);
      }
      const addedMedia = state.capturedItems.size - prevCount;

      const cursorShort = nextCursor ? (nextCursor.slice(0, 10) + '...') : '已至终点';
      if (badgeEl) badgeEl.textContent = `游标: ${cursorShort}`;
      if (statsEl) statsEl.innerHTML = `已推进: <strong>${state.chunkCount}</strong> 块 / 累计推文: <strong>~${state.rawTweetCount}</strong>`;
      if (pageEl) pageEl.textContent = `第 ${state.chunkCount} 块`;

      if (hintEl) {
        hintEl.textContent = `⚡ 第 ${state.chunkCount} 块完成：收到 20 条推文，新增 ${addedMedia} 媒体 (累计: ${state.capturedItems.size} 个)`;
      }

      const hasNext = Boolean(nextCursor && nextCursor !== state.nextCursor);
      state.nextCursor = nextCursor;
      return { success: true, addedMedia, hasNext, nextCursor };
    } else {
      if (hintEl) hintEl.textContent = `分块请求响应: ${reply?.error || '等待中'}，尝试微滚激活接口...`;
      window.scrollBy({ top: 1000, behavior: 'smooth' });
      await sleep(2000);
      return { success: false, error: reply?.error };
    }
  }

  // 单步拉取 1 个分块 (20条推文)
  async function stepSingleChunk() {
    if (state.isScraping) return;
    const stepBtn = document.getElementById('xmd-btn-chunk-step');
    if (stepBtn) stepBtn.disabled = true;

    try {
      await fetchSingleChunk();
      if (state.capturedItems.size > 0) {
        archiveTaskToDashboard(false);
      }
    } finally {
      if (stepBtn) stepBtn.disabled = false;
    }
  }

  // 连续游标分块流水线 (Chunk Stream)
  async function startChunkingLoop() {
    if (state.isScraping) return;

    state.isScraping = true;
    state.isPaused = false;

    const chunkTarget = parseInt(document.getElementById('xmd-opt-chunk-limit')?.value) || 0; // 0 为无限制
    const startBtn = document.getElementById('xmd-btn-start');
    const pauseBtn = document.getElementById('xmd-btn-pause');
    const stepBtn = document.getElementById('xmd-btn-chunk-step');
    const hintEl = document.getElementById('xmd-status-hint');

    if (startBtn) startBtn.disabled = true;
    if (stepBtn) stepBtn.disabled = true;
    if (pauseBtn) {
      pauseBtn.disabled = false;
      pauseBtn.textContent = '暂停';
    }

    let iterations = 0;
    while (state.isScraping) {
      if (state.isPaused) {
        await sleep(500);
        continue;
      }

      iterations++;
      const res = await fetchSingleChunk();

      if (!res.success) {
        // 请求遇阻稍作退避
        await sleep(3000);
        continue;
      }

      if (!res.hasNext) {
        if (hintEl) hintEl.textContent = `🎉 已抓取至时间线尽头，全部 ${state.chunkCount} 个分块拉取完毕！`;
        break;
      }

      if (chunkTarget > 0 && iterations >= chunkTarget) {
        if (hintEl) hintEl.textContent = `🎯 已达成指定目标: 推进 ${chunkTarget} 个分块 (约 ${chunkTarget * 20} 条推文)，抓取完成！`;
        break;
      }

      // 防风控阶梯退避
      const delay = getAdaptiveDelay(state.chunkCount);
      if (hintEl) hintEl.textContent = `防风控退避 ${(delay / 1000).toFixed(1)}s 后拉取下 1 块...`;
      await sleep(delay);
    }

    state.isScraping = false;
    if (startBtn) startBtn.disabled = false;
    if (stepBtn) stepBtn.disabled = false;
    if (pauseBtn) pauseBtn.disabled = true;

    if (state.capturedItems.size > 0) {
      archiveTaskToDashboard(false);
    }
  }

  function togglePause() {
    state.isPaused = !state.isPaused;
    const pauseBtn = document.getElementById('xmd-btn-pause');
    const hintEl = document.getElementById('xmd-status-hint');
    if (pauseBtn) pauseBtn.textContent = state.isPaused ? '继续' : '暂停';
    if (hintEl) hintEl.textContent = state.isPaused ? '游标分块任务已暂停' : '正在继续拉取下一分块...';
  }

  function resetData() {
    state.isScraping = false;
    state.isPaused = false;
    state.capturedItems.clear();
    state.selectedIds.clear();
    state.tweetMetaMap.clear();
    state.batchCount = 0;
    state.chunkCount = 0;
    state.rawTweetCount = 0;
    state.nextCursor = null;
    state.pageCount = 0;

    const badgeEl = document.getElementById('xmd-cursor-badge');
    if (badgeEl) badgeEl.textContent = '游标: 初始';
    const statsEl = document.getElementById('xmd-chunk-stats');
    if (statsEl) statsEl.innerHTML = '已推进: <strong>0</strong> 块 / 累计推文: <strong>~0</strong>';
    const pageEl = document.getElementById('xmd-page-info');
    if (pageEl) pageEl.textContent = '第 0 块';

    const grid = document.getElementById('xmd-gallery-grid');
    if (grid) grid.innerHTML = '';
    const tweetsCont = document.getElementById('xmd-tweets-container');
    if (tweetsCont) tweetsCont.innerHTML = '';
    const batchBadge = document.getElementById('xmd-batch-count-badge');
    if (batchBadge) batchBadge.style.display = 'none';

    const hintEl = document.getElementById('xmd-status-hint');
    if (hintEl) hintEl.textContent = '数据已清空，游标已重置';

    document.getElementById('xmd-btn-start').disabled = false;
    const stepBtn = document.getElementById('xmd-btn-chunk-step');
    if (stepBtn) stepBtn.disabled = false;
    document.getElementById('xmd-btn-pause').disabled = true;
    updateStatsUI();
  }

  // 6. 归档到总控制台
  function archiveTaskToDashboard(openAfterArchive = true) {
    const items = Array.from(state.capturedItems.values());
    if (items.length === 0) return;

    const detected = detectCurrentHandle() || 'X_User';
    const profile = {
      ...state.userProfile,
      screen_name: state.userProfile.screen_name || detected,
      name: state.userProfile.name || detected
    };

    chrome.runtime.sendMessage({
      type: 'CREATE_LOCAL_TASK',
      payload: {
        task_name: `${profile.name} 的媒体库`,
        user: profile,
        media_items: items
      }
    }, (res) => {
      if (res?.success && openAfterArchive) {
        chrome.runtime.sendMessage({
          type: 'OPEN_DASHBOARD',
          payload: { taskId: res.taskId }
        });
      }
    });
  }

  // 7. 单项与多选打包下载
  function downloadSingleMedia(item) {
    const handle = item.user?.screen_name || detectCurrentHandle() || 'X_User';
    const ext = item.mediaType === 'video' ? 'mp4' : 'jpg';
    const filename = `${handle}_${item.tweetId || 'media'}_${Date.now()}.${ext}`;

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        source: 'XMD_CONTENT',
        type: 'START_DOWNLOAD_BATCH',
        payload: {
          items: [item],
          folderName: `X-Media/${handle}`,
          concurrency: 1
        }
      });
    } else {
      const a = document.createElement('a');
      a.href = item.mediaUrl;
      a.download = filename;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  // --- 打包所选媒体为 ZIP ---
  async function downloadSelectedAsZip() {
    const selected = Array.from(state.capturedItems.values()).filter(it => state.selectedIds.has(it.mediaUrl));
    if (selected.length === 0) {
      alert('请先勾选需要打包的图片或视频！');
      return;
    }

    if (!window.JSZip) {
      alert('JSZip 依赖库未就绪，请使用原生下载或导出直链。');
      return;
    }

    const zip = new window.JSZip();
    const handle = state.userProfile.screen_name || detectCurrentHandle() || 'X_User';
    const folder = zip.folder(`${handle}_selected_media`);
    const hintEl = document.getElementById('xmd-status-hint');
    const fillEl = document.getElementById('xmd-progress-fill');

    let completed = 0;
    const total = selected.length;
    hintEl.textContent = `开始打包所选 ZIP，共 ${total} 个文件...`;

    const concurrency = 3;
    let idx = 0;

    async function downloadWorker() {
      while (idx < selected.length) {
        const i = idx++;
        const item = selected[i];
        const ext = item.mediaType === 'video' ? 'mp4' : 'jpg';
        const filename = `${handle}_${item.tweetId}_${String(i + 1).padStart(3, '0')}.${ext}`;

        try {
          const resp = await fetch(item.mediaUrl);
          const blob = await resp.blob();
          folder.file(filename, blob);
        } catch (err) {}

        completed++;
        const pct = Math.round((completed / total) * 100);
        if (fillEl) fillEl.style.width = `${pct}%`;
        if (hintEl) hintEl.textContent = `正在打包: ${completed}/${total} (${pct}%)`;
      }
    }

    const workers = [];
    for (let w = 0; w < concurrency; w++) workers.push(downloadWorker());
    await Promise.all(workers);

    hintEl.textContent = '正在压缩生成 ZIP 文件...';
    const content = await zip.generateAsync({ type: 'blob' }, (metadata) => {
      if (hintEl) hintEl.textContent = `压缩进度: ${metadata.percent.toFixed(0)}%`;
    });

    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${handle}_selected_${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    hintEl.textContent = `所选 ZIP 打包完成！共 ${completed} 个文件。`;
  }

  function downloadSelectedNative() {
    const selected = Array.from(state.capturedItems.values()).filter(it => state.selectedIds.has(it.mediaUrl));
    if (selected.length === 0) {
      alert('请先勾选需要下载的媒体！');
      return;
    }

    const handle = state.userProfile.screen_name || detectCurrentHandle() || 'X_User';
    const folderName = `X-Media/${handle}`;
    const hintEl = document.getElementById('xmd-status-hint');

    hintEl.textContent = `已推送到扩展下载队列，正在并发下载 ${selected.length} 个文件...`;

    chrome.runtime.sendMessage({
      source: 'XMD_CONTENT',
      type: 'START_DOWNLOAD_BATCH',
      payload: {
        items: selected,
        folderName,
        concurrency: 4
      }
    });
  }

  function exportSelectedTxt() {
    const selected = Array.from(state.capturedItems.values()).filter(it => state.selectedIds.has(it.mediaUrl));
    if (selected.length === 0) {
      alert('请先勾选需要导出的媒体！');
      return;
    }

    const urls = selected.map(it => it.mediaUrl).join('\n');
    const handle = state.userProfile.screen_name || detectCurrentHandle() || 'X_User';

    navigator.clipboard.writeText(urls).then(() => {
      const hintEl = document.getElementById('xmd-status-hint');
      if (hintEl) hintEl.textContent = `已将选中的 ${selected.length} 个直链复制到剪贴板！`;
    }).catch(() => {});

    const blob = new Blob([urls], { type: 'text/plain;charset=utf-8' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = `${handle}_selected_urls_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(u);
  }

  // 8. 信息流推文下载按钮 (In-Feed Download Button)
  function initTweetObserver() {
    const observer = new MutationObserver(() => scanAndInjectTweetButtons());
    observer.observe(document.body, { childList: true, subtree: true });
    scanAndInjectTweetButtons();
  }

  function scanAndInjectTweetButtons() {
    const tweets = document.querySelectorAll('article[data-testid="tweet"]:not([data-xmd-injected])');
    tweets.forEach(tweet => {
      tweet.setAttribute('data-xmd-injected', '1');
      injectDownloadButtonToTweet(tweet);
    });
  }

  function injectDownloadButtonToTweet(tweetArticle) {
    const actionGroup = tweetArticle.querySelector('div[role="group"]');
    if (!actionGroup) return;

    const statusLink = tweetArticle.querySelector('a[href*="/status/"]');
    const match = statusLink?.getAttribute('href')?.match(/\/status\/(\d+)/);
    const tweetId = match ? match[1] : '';

    const wrap = document.createElement('div');
    wrap.className = 'xmd-tweet-action-wrap';

    const btn = document.createElement('button');
    btn.className = 'xmd-tweet-dl-btn';
    btn.type = 'button';
    btn.title = 'X-Media-Downloader: 下载此推文媒体';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
      </svg>
    `;

    wrap.appendChild(btn);
    actionGroup.appendChild(wrap);

    let popover = null;

    btn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();

      const mediaItems = getMediaForTweet(tweetArticle, tweetId);
      if (mediaItems.length === 0) {
        alert('此推文中未检测到图片或视频');
        return;
      }

      if (mediaItems.length === 1) {
        downloadSingleMedia(mediaItems[0]);
        btn.classList.add('xmd-downloaded');
        btn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="#00ba7c">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
        `;
        setTimeout(() => {
          btn.classList.remove('xmd-downloaded');
          btn.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
            </svg>
          `;
        }, 2000);
      } else {
        if (popover) {
          popover.remove();
          popover = null;
        } else {
          popover = createPopoverMenu(mediaItems, wrap, () => {
            popover?.remove();
            popover = null;
          });
        }
      }
    };
  }

  function getMediaForTweet(tweetArticle, tweetId) {
    if (tweetId && state.tweetItemsMap.has(tweetId)) {
      return state.tweetItemsMap.get(tweetId);
    }

    const results = [];
    const imgs = tweetArticle.querySelectorAll('img[src*="pbs.twimg.com/media/"]');
    imgs.forEach((img, idx) => {
      const src = img.src;
      let origUrl = src;
      try {
        const u = new URL(src);
        u.searchParams.set('name', 'orig');
        origUrl = u.toString();
      } catch (e) {}

      results.push({
        id: `${tweetId}_img_${idx}`,
        tweetId,
        mediaType: 'image',
        mediaUrl: origUrl,
        thumbUrl: src
      });
    });

    const videos = tweetArticle.querySelectorAll('video');
    videos.forEach((vid, idx) => {
      results.push({
        id: `${tweetId}_vid_${idx}`,
        tweetId,
        mediaType: 'video',
        mediaUrl: vid.src,
        thumbUrl: vid.poster || ''
      });
    });

    return results;
  }

  function createPopoverMenu(items, parentWrap, onClose) {
    const pop = document.createElement('div');
    pop.className = 'xmd-popover-menu';

    let itemsHtml = '<div class="xmd-popover-items">';
    items.forEach((it, idx) => {
      itemsHtml += `
        <div class="xmd-popover-item" data-idx="${idx}">
          <img class="xmd-popover-thumb" src="${it.thumbUrl || it.mediaUrl}" />
          <span class="xmd-popover-label">${it.mediaType === 'video' ? 'MP4 视频' : `原图 #${idx + 1}`}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
          </svg>
        </div>
      `;
    });
    itemsHtml += '</div>';

    pop.innerHTML = `
      <div style="font-size:12px; font-weight:700; color:var(--xmd-text-muted);">包含 ${items.length} 个媒体</div>
      ${itemsHtml}
      <button class="xmd-popover-all-btn">全部下载 (共 ${items.length} 个)</button>
    `;

    parentWrap.appendChild(pop);

    pop.querySelectorAll('.xmd-popover-item').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(el.getAttribute('data-idx'));
        downloadSingleMedia(items[idx]);
      };
    });

    pop.querySelector('.xmd-popover-all-btn').onclick = (e) => {
      e.stopPropagation();
      items.forEach(it => downloadSingleMedia(it));
      onClose();
    };

    const docClick = (ev) => {
      if (!pop.contains(ev.target)) {
        document.removeEventListener('click', docClick);
        onClose();
      }
    };
    setTimeout(() => document.addEventListener('click', docClick), 50);

    return pop;
  }

  // 9. 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      createUI();
      initTweetObserver();
    });
  } else {
    createUI();
    initTweetObserver();
  }

})();
