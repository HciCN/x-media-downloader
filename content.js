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
    selectedIds: new Set(),   // 已勾选的媒体 URL 集合
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
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length > 0 && !['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i'].includes(parts[0])) {
      return parts[0].replace('@', '');
    }
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
          <div class="xmd-section-title">抓取配置</div>
          <div class="xmd-options-row">
            <select id="xmd-opt-limit" class="xmd-select">
              <option value="0">抓取全部媒体 (无限制)</option>
              <option value="50">抓取前 50 条</option>
              <option value="100">抓取前 100 条</option>
              <option value="200">抓取前 200 条</option>
            </select>
            <select id="xmd-opt-type" class="xmd-select">
              <option value="all">图片 + 视频</option>
              <option value="image">仅高清图片</option>
              <option value="video">仅视频 / GIF</option>
            </select>
          </div>
          <div class="xmd-checkbox-row" style="margin-top: 10px;">
            <label class="xmd-checkbox-label">
              <input type="checkbox" id="xmd-opt-skip-rt" checked /> 跳过转推 (RT)
            </label>
            <label class="xmd-checkbox-label">
              <input type="checkbox" id="xmd-opt-scroll-mode" /> 模拟滚动兜底
            </label>
          </div>
        </div>

        <div class="xmd-btn-group">
          <button id="xmd-btn-start" class="xmd-btn xmd-btn-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            开始批量抓取
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

        <!-- 媒体画廊与细粒度勾选工具栏 -->
        <div class="xmd-gallery-wrap">
          <div class="xmd-section-title" style="display:flex; justify-content:space-between; align-items:center;">
            <span>媒体预览 (<span id="xmd-gallery-count">0</span>)</span>
            <span style="font-weight:normal; text-transform:none; cursor:pointer; color:var(--xmd-accent);" id="xmd-btn-toggle-gallery">展开/收起</span>
          </div>

          <div class="xmd-selection-toolbar" id="xmd-selection-toolbar" style="display:none;">
            <div class="xmd-mini-btn-group">
              <button class="xmd-mini-btn" id="xmd-btn-select-all">全选</button>
              <button class="xmd-mini-btn" id="xmd-btn-select-none">全不选</button>
              <button class="xmd-mini-btn" id="xmd-btn-select-invert">反选</button>
            </div>
            <span>已选: <strong id="xmd-selected-count" style="color:var(--xmd-accent);">0</strong> 项</span>
          </div>

          <div id="xmd-gallery-grid" class="xmd-gallery-grid" style="display:none;"></div>
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
      chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
    };

    document.getElementById('xmd-btn-toggle-gallery').onclick = () => {
      const g = document.getElementById('xmd-gallery-grid');
      const tb = document.getElementById('xmd-selection-toolbar');
      const isHidden = g.style.display === 'none';
      g.style.display = isHidden ? 'grid' : 'none';
      tb.style.display = isHidden ? 'flex' : 'none';
    };

    // 勾选快捷操作
    document.getElementById('xmd-btn-select-all').onclick = () => {
      state.capturedItems.forEach(it => state.selectedIds.add(it.mediaUrl));
      updateSelectionUI();
    };

    document.getElementById('xmd-btn-select-none').onclick = () => {
      state.selectedIds.clear();
      updateSelectionUI();
    };

    document.getElementById('xmd-btn-select-invert').onclick = () => {
      state.capturedItems.forEach(it => {
        if (state.selectedIds.has(it.mediaUrl)) state.selectedIds.delete(it.mediaUrl);
        else state.selectedIds.add(it.mediaUrl);
      });
      updateSelectionUI();
    };

    document.getElementById('xmd-lightbox-close').onclick = closeLightbox;
    lightbox.onclick = (e) => {
      if (e.target === lightbox) closeLightbox();
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });

    document.getElementById('xmd-btn-start').onclick = startScraping;
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

  function addMediaItems(items) {
    const skipRt = document.getElementById('xmd-opt-skip-rt')?.checked ?? true;
    const typeFilter = document.getElementById('xmd-opt-type')?.value ?? 'all';

    for (const item of items) {
      if (item.tweetId) {
        if (!state.tweetItemsMap.has(item.tweetId)) {
          state.tweetItemsMap.set(item.tweetId, []);
        }
        const list = state.tweetItemsMap.get(item.tweetId);
        if (!list.some(x => x.mediaUrl === item.mediaUrl)) {
          list.push(item);
        }
      }

      if (skipRt && item.isRetweet) continue;
      if (typeFilter === 'image' && item.mediaType !== 'image') continue;
      if (typeFilter === 'video' && item.mediaType !== 'video') continue;

      const key = item.mediaUrl;
      if (!state.capturedItems.has(key)) {
        state.capturedItems.set(key, item);
        state.selectedIds.add(key); // 新增条目默认勾选
        appendThumbToGallery(item);
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
    const gCount = document.getElementById('xmd-gallery-count');

    if (badge) {
      badge.textContent = total > 999 ? '999+' : total;
      badge.style.display = total > 0 ? 'block' : 'none';
    }
    if (totalEl) totalEl.textContent = total;
    if (imgEl) imgEl.textContent = imgCount;
    if (vidEl) vidEl.textContent = vidCount;
    if (gCount) gCount.textContent = total;

    updateSelectionUI();

    const hasItems = total > 0;
    ['xmd-btn-zip', 'xmd-btn-native-dl', 'xmd-btn-export-txt', 'xmd-btn-archive-task'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = !hasItems;
    });
  }

  function updateSelectionUI() {
    const selCount = state.selectedIds.size;
    const countEl = document.getElementById('xmd-selected-count');
    if (countEl) countEl.textContent = selCount;

    const zipBtn = document.getElementById('xmd-btn-zip');
    const dlBtn = document.getElementById('xmd-btn-native-dl');
    const txtBtn = document.getElementById('xmd-btn-export-txt');

    if (zipBtn) zipBtn.textContent = `打包所选为 ZIP (${selCount})`;
    if (dlBtn) dlBtn.textContent = `下载所选 (${selCount})`;
    if (txtBtn) txtBtn.textContent = `复制所选直链 (${selCount})`;

    // 更新各缩略图选中状态
    document.querySelectorAll('.xmd-thumb-item').forEach(el => {
      const url = el.getAttribute('data-url');
      const cb = el.querySelector('.xmd-thumb-checkbox');
      const isSel = state.selectedIds.has(url);
      if (cb) cb.checked = isSel;
      if (isSel) el.classList.add('selected');
      else el.classList.remove('selected');
    });
  }

  function appendThumbToGallery(item) {
    const grid = document.getElementById('xmd-gallery-grid');
    if (!grid) return;

    const div = document.createElement('div');
    div.className = 'xmd-thumb-item selected';
    div.setAttribute('data-url', item.mediaUrl);
    div.title = `点击在线预览 (${item.mediaType})\n${item.tweetText || ''}`;

    div.innerHTML = `
      <input type="checkbox" class="xmd-thumb-checkbox" checked />
      <img class="xmd-thumb-img" src="${item.thumbUrl || item.mediaUrl}" loading="lazy" />
      <span class="xmd-thumb-badge">${item.mediaType === 'video' ? 'MP4' : 'IMG'}</span>
    `;

    const cb = div.querySelector('.xmd-thumb-checkbox');
    cb.onclick = (e) => {
      e.stopPropagation();
      if (cb.checked) state.selectedIds.add(item.mediaUrl);
      else state.selectedIds.delete(item.mediaUrl);
      updateSelectionUI();
    };

    div.onclick = () => openLightbox(item);
    grid.appendChild(div);
  }

  // 5. 抓取控制主循环
  async function startScraping() {
    if (state.isScraping) return;

    state.isScraping = true;
    state.isPaused = false;
    state.pageCount = 0;
    state.limitCount = parseInt(document.getElementById('xmd-opt-limit').value) || 0;
    state.skipRetweets = document.getElementById('xmd-opt-skip-rt').checked;
    state.filterType = document.getElementById('xmd-opt-type').value;

    const startBtn = document.getElementById('xmd-btn-start');
    const pauseBtn = document.getElementById('xmd-btn-pause');
    const hintEl = document.getElementById('xmd-status-hint');
    const pageEl = document.getElementById('xmd-page-info');

    startBtn.disabled = true;
    pauseBtn.disabled = false;
    pauseBtn.textContent = '暂停';

    hintEl.textContent = '正在初始化抓取任务...';

    if (!state.queryConfig) {
      hintEl.textContent = '正在嗅探 Twitter 接口，请稍候...';
      window.scrollBy({ top: 800, behavior: 'smooth' });
      await sleep(1500);
    }

    while (state.isScraping) {
      if (state.isPaused) {
        await sleep(500);
        continue;
      }

      state.pageCount++;
      if (pageEl) pageEl.textContent = `第 ${state.pageCount} 页`;

      if (state.limitCount > 0 && state.capturedItems.size >= state.limitCount) {
        hintEl.textContent = `已达到设定上限 (${state.limitCount} 条)，抓取完成！`;
        break;
      }

      const useScrollMode = document.getElementById('xmd-opt-scroll-mode').checked;

      if (!useScrollMode && state.queryConfig) {
        hintEl.textContent = `正在请求第 ${state.pageCount} 页数据...`;

        const requestId = ++state.requestIdSeed;
        const variables = {
          ...(state.queryConfig.variables || {}),
          count: 20
        };
        if (state.nextCursor) {
          variables.cursor = state.nextCursor;
        }

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
            endpointUrl: state.queryConfig.urlTemplate,
            variables,
            features: state.queryConfig.features,
            fieldToggles: state.queryConfig.fieldToggles
          }
        }, '*');

        const reply = await fetchPromise;

        if (reply.success && reply.data) {
          const { items, nextCursor, profile } = reply.data;
          if (profile) updateProfileUI(profile);
          if (items && items.length > 0) addMediaItems(items);

          if (!nextCursor || nextCursor === state.nextCursor || items.length === 0) {
            hintEl.textContent = '已抓取至时间线最底部，无更多推文。';
            break;
          }
          state.nextCursor = nextCursor;
        } else {
          hintEl.textContent = `接口返回限流: ${reply.error || '等待中'}，切换滚动兜底...`;
          window.scrollBy({ top: 1200, behavior: 'smooth' });
          await sleep(2500);
        }
      } else {
        hintEl.textContent = `模拟滚动加载第 ${state.pageCount} 页...`;
        window.scrollBy({ top: 1400, behavior: 'smooth' });
        await sleep(1800);
      }

      const delay = getAdaptiveDelay(state.pageCount);
      hintEl.textContent = `防风控等待 ${(delay / 1000).toFixed(1)}s 后加载下一页...`;
      await sleep(delay);
    }

    state.isScraping = false;
    startBtn.disabled = false;
    pauseBtn.disabled = true;

    // 抓取结束自动归档至本地数据库
    if (state.capturedItems.size > 0) {
      archiveTaskToDashboard(false);
      hintEl.textContent = `抓取完成！共 ${state.capturedItems.size} 个媒体，已归档至总控台！`;
    }
  }

  function togglePause() {
    state.isPaused = !state.isPaused;
    const pauseBtn = document.getElementById('xmd-btn-pause');
    const hintEl = document.getElementById('xmd-status-hint');
    if (pauseBtn) pauseBtn.textContent = state.isPaused ? '继续' : '暂停';
    if (hintEl) hintEl.textContent = state.isPaused ? '任务已暂停' : '正在继续抓取...';
  }

  function resetData() {
    state.isScraping = false;
    state.isPaused = false;
    state.capturedItems.clear();
    state.selectedIds.clear();
    state.nextCursor = null;
    state.pageCount = 0;

    const grid = document.getElementById('xmd-gallery-grid');
    if (grid) grid.innerHTML = '';
    const hintEl = document.getElementById('xmd-status-hint');
    if (hintEl) hintEl.textContent = '数据已清空';

    document.getElementById('xmd-btn-start').disabled = false;
    document.getElementById('xmd-btn-pause').disabled = true;
    updateStatsUI();
  }

  // 6. 归档到总控制台
  function archiveTaskToDashboard(openAfterArchive = true) {
    const items = Array.from(state.capturedItems.values());
    if (items.length === 0) return;

    chrome.runtime.sendMessage({
      type: 'CREATE_LOCAL_TASK',
      payload: {
        task_name: `${state.userProfile.name || detectCurrentHandle()} 的媒体库`,
        user: state.userProfile,
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

    chrome.runtime.sendMessage({
      source: 'XMD_CONTENT',
      type: 'START_DOWNLOAD_BATCH',
      payload: {
        items: [item],
        folderName: `X-Media/${handle}`,
        concurrency: 1
      }
    });

    const a = document.createElement('a');
    a.href = item.mediaUrl;
    a.download = filename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
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
