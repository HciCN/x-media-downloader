// ==UserScript==
// @name         X/Twitter 批量媒体抓取与下载器 (X-Media-Downloader)
// @namespace    https://xbd.plucker.io/
// @version      1.1.0
// @description  一键批量抓取并下载 X/Twitter 博主的高清原图与最高码率 MP4 视频，支持信息流单推文直接秒存、多图弹窗选择、悬浮球拖拽、内置视频播放器、自动游标翻页与防风控退避
// @author       Antigravity
// @match        https://x.com/*
// @match        https://twitter.com/*
// @icon         https://abs.twimg.com/favicons/twitter.3.ico
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  console.log('[XMD-UserScript] Loaded on', location.href);

  const state = {
    userProfile: { name: '', screen_name: '', avatar: '', rest_id: '' },
    capturedItems: new Map(),
    tweetItemsMap: new Map(),
    queryConfig: null,
    headers: {},
    nextCursor: null,
    isScraping: false,
    isPaused: false,
    limitCount: 0,
    pageCount: 0
  };

  function getAdaptiveDelay(page) {
    if (page < 5) return 800 + Math.random() * 800;
    if (page < 10) return 1500 + Math.random() * 1000;
    if (page < 20) return 3000 + Math.random() * 2000;
    if (page < 50) return 5000 + Math.random() * 3000;
    return 10000 + Math.random() * 8000;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function filterApiHeaders(headersObj) {
    const filtered = {};
    const targetKeys = ['authorization', 'x-csrf-token', 'x-client-transaction-id', 'x-twitter-active-user', 'x-twitter-auth-type', 'x-twitter-client-language'];
    for (const [k, v] of Object.entries(headersObj || {})) {
      const lower = k.toLowerCase();
      if (targetKeys.includes(lower)) filtered[lower] = v;
    }
    if (!filtered['x-csrf-token']) {
      const ct0 = getCsrfToken();
      if (ct0) filtered['x-csrf-token'] = ct0;
    }
    return filtered;
  }

  function parseGraphQLTimeline(json) {
    if (!json || typeof json !== 'object') return { items: [], nextCursor: null, profile: null };

    const items = [];
    let nextCursor = null;
    let userProfile = null;

    function walkEntries(obj) {
      if (!obj || typeof obj !== 'object') return;

      if (obj.entryType === 'TimelineTimelineCursor' || obj.__typename === 'TimelineTimelineCursor') {
        if (obj.cursorType === 'Bottom' || obj.cursorType === 'ShowMoreThreads') {
          if (obj.value && typeof obj.value === 'string') nextCursor = obj.value;
        }
      }

      if (obj.entryType === 'TimelineTimelineItem' || obj.__typename === 'TimelineTimelineItem') {
        const itemContent = obj.itemContent;
        if (itemContent && (itemContent.itemType === 'TimelineTweet' || itemContent.__typename === 'TimelineTweet')) {
          const tweetResult = itemContent.tweet_results?.result;
          if (tweetResult) extractTweetData(tweetResult);
        }
      }

      for (const val of Object.values(obj)) {
        if (Array.isArray(val)) {
          for (const item of val) walkEntries(item);
        } else if (val && typeof val === 'object') {
          walkEntries(val);
        }
      }
    }

    function extractTweetData(tweetObj) {
      const tweet = tweetObj.__typename === 'TweetWithVisibilityResults' ? tweetObj.tweet : tweetObj;
      if (!tweet || !tweet.legacy) return;
      const legacy = tweet.legacy;

      const userResult = tweet.core?.user_results?.result;
      if (userResult && !userProfile) {
        const uLegacy = userResult.legacy || {};
        userProfile = {
          rest_id: userResult.rest_id,
          name: uLegacy.name || '',
          screen_name: uLegacy.screen_name || '',
          avatar: uLegacy.profile_image_url_https ? uLegacy.profile_image_url_https.replace('_normal', '_400x400') : '',
          description: uLegacy.description || ''
        };
      }

      const tweetId = tweet.rest_id || legacy.id_str;
      const tweetText = legacy.full_text || '';
      const createdAt = legacy.created_at;
      const isRetweet = Boolean(legacy.retweeted_status_result || legacy.retweeted || tweetText.startsWith('RT @'));

      let mediaEntities = legacy.extended_entities?.media || legacy.entities?.media || [];
      if (isRetweet && tweet.retweeted_status_result?.result) {
        const rtLegacy = tweet.retweeted_status_result.result.legacy || {};
        mediaEntities = rtLegacy.extended_entities?.media || rtLegacy.entities?.media || mediaEntities;
      }

      const currentTweetList = [];
      for (const m of mediaEntities) {
        const mediaId = m.id_str;
        const type = (m.type || '').toLowerCase();
        let mediaUrl = '';
        let mediaType = 'image';

        if (type === 'video' || type === 'animated_gif') {
          mediaType = 'video';
          const variants = m.video_info?.variants || [];
          const mp4s = variants
            .filter(v => v.content_type === 'video/mp4')
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (mp4s.length > 0) mediaUrl = mp4s[0].url;
          else if (variants.length > 0) mediaUrl = variants[0].url;
        } else {
          mediaType = 'image';
          const rawUrl = m.media_url_https || m.media_url || '';
          if (rawUrl) {
            const u = new URL(rawUrl);
            u.searchParams.set('name', 'orig');
            mediaUrl = u.toString();
          }
        }

        if (mediaUrl) {
          const it = {
            id: mediaId || `${tweetId}_${items.length}`,
            tweetId: tweetId,
            mediaType: mediaType,
            mediaUrl: mediaUrl,
            thumbUrl: m.media_url_https || mediaUrl,
            tweetText: tweetText,
            createdAt: createdAt,
            isRetweet: isRetweet,
            user: userProfile || { screen_name: legacy.user_id_str || '' }
          };
          items.push(it);
          currentTweetList.push(it);
        }
      }

      if (tweetId && currentTweetList.length > 0) {
        state.tweetItemsMap.set(tweetId, currentTweetList);
      }
    }

    try { walkEntries(json); } catch (e) {}
    return { items, nextCursor, profile: userProfile };
  }

  // 拦截 fetch
  const origFetch = win.fetch;
  win.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    if (typeof url === 'string' && url.includes('/i/api/graphql/')) {
      const headers = {};
      if (init && init.headers) {
        if (init.headers instanceof Headers) init.headers.forEach((v, k) => { headers[k] = v; });
        else if (Array.isArray(init.headers)) init.headers.forEach(([k, v]) => { headers[k] = v; });
        else Object.assign(headers, init.headers);
      }
      Object.assign(state.headers, filterApiHeaders(headers));

      try {
        const parsedUrl = new URL(url, location.origin);
        const match = parsedUrl.pathname.match(/\/graphql\/([^/]+)\/([a-zA-Z0-9_-]+)/);
        if (match && ['UserMedia', 'UserTweets', 'UserPhotoTimeline', 'UserVideoTimeline'].includes(match[2])) {
          state.queryConfig = {
            queryId: match[1],
            queryName: match[2],
            urlTemplate: parsedUrl.origin + parsedUrl.pathname,
            variables: JSON.parse(parsedUrl.searchParams.get('variables') || '{}'),
            features: JSON.parse(parsedUrl.searchParams.get('features') || '{}'),
            fieldToggles: JSON.parse(parsedUrl.searchParams.get('fieldToggles') || '{}')
          };
        }
      } catch (e) {}
    }

    const response = await origFetch.apply(this, arguments);

    if (typeof url === 'string' && url.includes('/i/api/graphql/')) {
      try {
        const clone = response.clone();
        clone.json().then(data => {
          const { items, nextCursor, profile } = parseGraphQLTimeline(data);
          if (profile) updateProfileUI(profile);
          if (nextCursor) state.nextCursor = nextCursor;
          if (items.length > 0) addMediaItems(items);
        }).catch(() => {});
      } catch (e) {}
    }
    return response;
  };

  // UI 样式
  const styles = `
    #xmd-float-trigger {
      position: fixed; bottom: 28px; right: 28px; width: 54px; height: 54px; border-radius: 50%;
      background: #1d9bf0; box-shadow: 0 6px 20px rgba(29, 155, 240, 0.45); cursor: grab;
      z-index: 999999; display: flex; align-items: center; justify-content: center;
      transition: box-shadow 0.2s ease, transform 0.1s ease; user-select: none; touch-action: none;
    }
    #xmd-float-trigger.xmd-dragging { cursor: grabbing; transform: scale(1.12); box-shadow: 0 10px 30px rgba(29, 155, 240, 0.75); }
    #xmd-float-trigger svg { width: 26px; height: 26px; fill: #ffffff; pointer-events: none; }
    #xmd-float-badge {
      position: absolute; top: -4px; right: -4px; background: #f91880; color: #fff;
      font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 12px; border: 2px solid #000; display: none; pointer-events: none;
    }
    #xmd-panel {
      position: fixed; bottom: 95px; right: 28px; width: 430px; max-width: calc(100vw - 40px);
      max-height: 85vh; background: rgba(22, 24, 28, 0.95); backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px); border: 1px solid #2f3336; border-radius: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.8); z-index: 999999; color: #e7e9ea;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; flex-direction: column; overflow: hidden; transition: all 0.25s ease;
    }
    #xmd-panel.xmd-hidden { opacity: 0; transform: scale(0.92) translateY(20px); pointer-events: none; }
    .xmd-header { padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #2f3336; background: rgba(0,0,0,0.3); }
    .xmd-user-info { display: flex; align-items: center; gap: 12px; overflow: hidden; }
    .xmd-avatar { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; }
    .xmd-name { font-weight: 700; font-size: 15px; }
    .xmd-handle { font-size: 13px; color: #71767b; }
    .xmd-body { padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
    .xmd-stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .xmd-stat-card { background: #202327; border: 1px solid rgba(255,255,255,0.05); border-radius: 8px; padding: 10px; text-align: center; }
    .xmd-stat-num { font-size: 18px; font-weight: 800; }
    .xmd-stat-num.accent { color: #1d9bf0; }
    .xmd-stat-num.success { color: #00ba7c; }
    .xmd-stat-num.warning { color: #ffd400; }
    .xmd-stat-label { font-size: 11px; color: #71767b; margin-top: 2px; }
    .xmd-select { width: 100%; background: #202327; border: 1px solid #2f3336; border-radius: 8px; color: #e7e9ea; padding: 8px 12px; font-size: 13px; }
    .xmd-btn { padding: 10px; border-radius: 8px; font-size: 13px; font-weight: 700; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
    .xmd-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .xmd-btn-primary { background: #1d9bf0; color: #fff; flex: 2; }
    .xmd-btn-secondary { background: #202327; color: #e7e9ea; border: 1px solid #2f3336; flex: 1; }
    .xmd-btn-success { background: #00ba7c; color: #fff; }
    .xmd-export-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .xmd-progress-bar-bg { width: 100%; height: 6px; background: #202327; border-radius: 3px; overflow: hidden; }
    .xmd-progress-bar-fill { width: 0%; height: 100%; background: linear-gradient(90deg, #1d9bf0, #45b7ff); transition: width 0.2s; }
    .xmd-gallery-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; max-height: 160px; overflow-y: auto; }
    .xmd-thumb-item { position: relative; width: 100%; aspect-ratio: 1; border-radius: 6px; overflow: hidden; background: #202327; cursor: pointer; }
    .xmd-thumb-item img { width: 100%; height: 100%; object-fit: cover; }
    .xmd-thumb-badge { position: absolute; bottom: 3px; right: 3px; background: rgba(0,0,0,0.8); color: #fff; font-size: 9px; padding: 1px 3px; border-radius: 3px; }

    /* Lightbox 播放器 */
    #xmd-lightbox {
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.88);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); z-index: 1000000;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      opacity: 0; pointer-events: none; transition: opacity 0.2s;
    }
    #xmd-lightbox.xmd-active { opacity: 1; pointer-events: auto; }
    .xmd-lightbox-media { max-width: 90vw; max-height: 80vh; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.9); }
    .xmd-lightbox-close { position: absolute; top: 20px; right: 24px; background: rgba(255,255,255,0.2); border: none; color: #fff; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; font-size: 18px; }

    /* 推文操作栏图标与弹窗 */
    .xmd-tweet-action-wrap { display: inline-flex; align-items: center; position: relative; user-select: none; }
    .xmd-tweet-dl-btn { background: transparent; border: none; cursor: pointer; color: rgb(113, 118, 123); padding: 8px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: color 0.15s, background-color 0.15s; }
    .xmd-tweet-dl-btn:hover { color: #1d9bf0; background-color: rgba(29, 155, 240, 0.1); }
    .xmd-tweet-dl-btn svg { width: 18.75px; height: 18.75px; fill: currentColor; }
    .xmd-popover-menu { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); background: #16181c; border: 1px solid #2f3336; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.7); padding: 10px; z-index: 99999; min-width: 200px; display: flex; flex-direction: column; gap: 8px; }
    .xmd-popover-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; background: #202327; cursor: pointer; }
    .xmd-popover-thumb { width: 34px; height: 34px; border-radius: 4px; object-fit: cover; }
    .xmd-popover-all-btn { background: #1d9bf0; color: #fff; border: none; border-radius: 6px; padding: 8px; font-size: 12px; font-weight: 700; cursor: pointer; }
  `;

  function initUI() {
    if (document.getElementById('xmd-float-trigger')) return;

    const styleEl = document.createElement('style');
    styleEl.textContent = styles;
    document.head.appendChild(styleEl);

    const trigger = document.createElement('div');
    trigger.id = 'xmd-float-trigger';
    trigger.title = '长按可拖动 | 点击打开 X/Twitter 批量媒体下载器';
    trigger.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg><div id="xmd-float-badge">0</div>`;

    const savedPos = localStorage.getItem('xmd_trigger_pos');
    if (savedPos) {
      try {
        const { left, top } = JSON.parse(savedPos);
        trigger.style.left = `${Math.max(10, Math.min(window.innerWidth - 64, left))}px`;
        trigger.style.top = `${Math.max(10, Math.min(window.innerHeight - 64, top))}px`;
        trigger.style.right = 'auto'; trigger.style.bottom = 'auto';
      } catch (e) {}
    }

    const panel = document.createElement('div');
    panel.id = 'xmd-panel';
    panel.className = 'xmd-hidden';
    panel.innerHTML = `
      <div class="xmd-header">
        <div class="xmd-user-info">
          <img id="xmd-avatar" class="xmd-avatar" src="" style="display:none;" />
          <div><div id="xmd-name" class="xmd-name">准备就绪</div><div id="xmd-handle" class="xmd-handle">@X-User</div></div>
        </div>
        <button id="xmd-btn-close" style="background:transparent;border:none;color:#71767b;cursor:pointer;font-size:18px;">✕</button>
      </div>

      <div class="xmd-body">
        <div class="xmd-stats-grid">
          <div class="xmd-stat-card"><div id="xmd-stat-total" class="xmd-stat-num accent">0</div><div class="xmd-stat-label">总媒体数</div></div>
          <div class="xmd-stat-card"><div id="xmd-stat-images" class="xmd-stat-num success">0</div><div class="xmd-stat-label">高清图片</div></div>
          <div class="xmd-stat-card"><div id="xmd-stat-videos" class="xmd-stat-num warning">0</div><div class="xmd-stat-label">高码率视频</div></div>
        </div>

        <div>
          <div style="display:flex; justify-content:space-between; font-size:12px; color:#71767b; margin-bottom:4px;">
            <span id="xmd-status-label">就绪</span><span id="xmd-page-info">第 0 页</span>
          </div>
          <div class="xmd-progress-bar-bg"><div id="xmd-progress-fill" class="xmd-progress-bar-fill"></div></div>
          <div id="xmd-status-hint" style="font-size:12px; color:#1d9bf0; margin-top:4px; min-height:16px;"></div>
        </div>

        <div style="display:flex; gap:8px;">
          <select id="xmd-opt-limit" class="xmd-select">
            <option value="0">全部抓取 (无限制)</option>
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

        <div style="display:flex; gap:8px;">
          <button id="xmd-btn-start" class="xmd-btn xmd-btn-primary">开始批量抓取</button>
          <button id="xmd-btn-pause" class="xmd-btn xmd-btn-secondary" disabled>暂停</button>
          <button id="xmd-btn-reset" class="xmd-btn xmd-btn-secondary">重置</button>
        </div>

        <div class="xmd-export-grid">
          <button id="xmd-btn-zip" class="xmd-btn xmd-btn-success" disabled>一键打包 ZIP</button>
          <button id="xmd-btn-export-txt" class="xmd-btn xmd-btn-secondary" disabled>复制/导出直链</button>
        </div>

        <div>
          <div style="font-size:12px; font-weight:700; color:#71767b; margin-bottom:6px;">媒体预览 (点击在线播放/查看)</div>
          <div id="xmd-gallery-grid" class="xmd-gallery-grid"></div>
        </div>
      </div>
    `;

    const lightbox = document.createElement('div');
    lightbox.id = 'xmd-lightbox';
    lightbox.innerHTML = `
      <button class="xmd-lightbox-close" id="xmd-lightbox-close">✕</button>
      <div id="xmd-lightbox-content" style="display:flex; flex-direction:column; align-items:center;">
        <div id="xmd-lightbox-media-container"></div>
        <button id="xmd-lightbox-dl-btn" class="xmd-btn xmd-btn-primary" style="margin-top:12px; padding:8px 20px;">立即下载</button>
      </div>
    `;

    document.body.appendChild(trigger);
    document.body.appendChild(panel);
    document.body.appendChild(lightbox);

    makeDraggable(trigger, () => panel.classList.toggle('xmd-hidden'));
    document.getElementById('xmd-btn-close').onclick = () => panel.classList.add('xmd-hidden');
    document.getElementById('xmd-lightbox-close').onclick = closeLightbox;
    lightbox.onclick = (e) => { if (e.target === lightbox) closeLightbox(); };

    document.getElementById('xmd-btn-start').onclick = startScraping;
    document.getElementById('xmd-btn-pause').onclick = togglePause;
    document.getElementById('xmd-btn-reset').onclick = resetData;
    document.getElementById('xmd-btn-zip').onclick = downloadAsZip;
    document.getElementById('xmd-btn-export-txt').onclick = exportTxt;
  }

  function makeDraggable(el, onClickCallback) {
    let isDragging = false, startX = 0, startY = 0, initialLeft = 0, initialTop = 0, hasMoved = false;

    function onDown(e) {
      if (e.button !== 0 && e.type !== 'touchstart') return;
      isDragging = true; hasMoved = false;
      const cx = e.clientX ?? e.touches[0].clientX;
      const cy = e.clientY ?? e.touches[0].clientY;
      startX = cx; startY = cy;
      const rect = el.getBoundingClientRect();
      initialLeft = rect.left; initialTop = rect.top;
      el.classList.add('xmd-dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchend', onUp);
    }

    function onMove(e) {
      if (!isDragging) return;
      const cx = e.clientX ?? (e.touches ? e.touches[0].clientX : startX);
      const cy = e.clientY ?? (e.touches ? e.touches[0].clientY : startY);
      const dx = cx - startX, dy = cy - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) hasMoved = true;
      if (hasMoved) {
        if (e.cancelable) e.preventDefault();
        const maxL = window.innerWidth - el.offsetWidth - 10;
        const maxT = window.innerHeight - el.offsetHeight - 10;
        el.style.left = `${Math.max(10, Math.min(maxL, initialLeft + dx))}px`;
        el.style.top = `${Math.max(10, Math.min(maxT, initialTop + dy))}px`;
        el.style.right = 'auto'; el.style.bottom = 'auto';
      }
    }

    function onUp() {
      if (!isDragging) return;
      isDragging = false;
      el.classList.remove('xmd-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onUp);
      if (hasMoved) {
        const rect = el.getBoundingClientRect();
        localStorage.setItem('xmd_trigger_pos', JSON.stringify({ left: rect.left, top: rect.top }));
      } else {
        onClickCallback?.();
      }
    }

    el.addEventListener('mousedown', onDown);
    el.addEventListener('touchstart', onDown, { passive: false });
  }

  function openLightbox(item) {
    const box = document.getElementById('xmd-lightbox');
    const container = document.getElementById('xmd-lightbox-media-container');
    const dlBtn = document.getElementById('xmd-lightbox-dl-btn');
    if (!box || !container) return;
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
    dlBtn.onclick = () => downloadSingleMedia(item);
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

  function downloadSingleMedia(item) {
    const handle = item.user?.screen_name || 'X_User';
    const ext = item.mediaType === 'video' ? 'mp4' : 'jpg';
    const name = `${handle}_${item.tweetId || 'media'}_${Date.now()}.${ext}`;

    if (typeof GM_download !== 'undefined') {
      GM_download({ url: item.mediaUrl, name: name });
    } else {
      const a = document.createElement('a');
      a.href = item.mediaUrl;
      a.download = name;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  function updateProfileUI(profile) {
    if (!profile) return;
    Object.assign(state.userProfile, profile);
    const nameEl = document.getElementById('xmd-name');
    const handleEl = document.getElementById('xmd-handle');
    const avatarEl = document.getElementById('xmd-avatar');
    if (nameEl && profile.name) nameEl.textContent = profile.name;
    if (handleEl && profile.screen_name) handleEl.textContent = `@${profile.screen_name}`;
    if (avatarEl && profile.avatar) { avatarEl.src = profile.avatar; avatarEl.style.display = 'block'; }
  }

  function addMediaItems(items) {
    const typeFilter = document.getElementById('xmd-opt-type')?.value ?? 'all';
    for (const item of items) {
      if (item.tweetId) {
        if (!state.tweetItemsMap.has(item.tweetId)) state.tweetItemsMap.set(item.tweetId, []);
        const list = state.tweetItemsMap.get(item.tweetId);
        if (!list.some(x => x.mediaUrl === item.mediaUrl)) list.push(item);
      }
      if (typeFilter === 'image' && item.mediaType !== 'image') continue;
      if (typeFilter === 'video' && item.mediaType !== 'video') continue;
      const key = item.mediaUrl;
      if (!state.capturedItems.has(key)) {
        state.capturedItems.set(key, item);
        appendThumb(item);
      }
    }
    updateStatsUI();
  }

  function updateStatsUI() {
    let imgCount = 0, vidCount = 0;
    for (const it of state.capturedItems.values()) {
      if (it.mediaType === 'video') vidCount++; else imgCount++;
    }
    const total = state.capturedItems.size;
    const badge = document.getElementById('xmd-float-badge');
    if (badge) { badge.textContent = total; badge.style.display = total > 0 ? 'block' : 'none'; }
    const t = document.getElementById('xmd-stat-total'); if (t) t.textContent = total;
    const i = document.getElementById('xmd-stat-images'); if (i) i.textContent = imgCount;
    const v = document.getElementById('xmd-stat-videos'); if (v) v.textContent = vidCount;

    const has = total > 0;
    const bZip = document.getElementById('xmd-btn-zip'); if (bZip) bZip.disabled = !has;
    const bTxt = document.getElementById('xmd-btn-export-txt'); if (bTxt) bTxt.disabled = !has;
  }

  function appendThumb(item) {
    const grid = document.getElementById('xmd-gallery-grid');
    if (!grid) return;
    const div = document.createElement('div');
    div.className = 'xmd-thumb-item';
    div.onclick = () => openLightbox(item);
    div.innerHTML = `<img src="${item.thumbUrl || item.mediaUrl}" loading="lazy" /><span class="xmd-thumb-badge">${item.mediaType === 'video' ? 'MP4' : 'IMG'}</span>`;
    grid.appendChild(div);
  }

  async function startScraping() {
    if (state.isScraping) return;
    state.isScraping = true;
    state.isPaused = false;
    state.pageCount = 0;
    state.limitCount = parseInt(document.getElementById('xmd-opt-limit').value) || 0;

    const startBtn = document.getElementById('xmd-btn-start');
    const pauseBtn = document.getElementById('xmd-btn-pause');
    const hintEl = document.getElementById('xmd-status-hint');
    const pageEl = document.getElementById('xmd-page-info');

    startBtn.disabled = true;
    pauseBtn.disabled = false;
    pauseBtn.textContent = '暂停';

    if (!state.queryConfig) {
      hintEl.textContent = '嗅探接口中，正在平滑滚动...';
      window.scrollBy({ top: 800, behavior: 'smooth' });
      await sleep(1500);
    }

    while (state.isScraping) {
      if (state.isPaused) { await sleep(500); continue; }
      state.pageCount++;
      if (pageEl) pageEl.textContent = `第 ${state.pageCount} 页`;

      if (state.limitCount > 0 && state.capturedItems.size >= state.limitCount) {
        hintEl.textContent = `已达到目标上限 (${state.limitCount}条)，抓取完成！`;
        break;
      }

      if (state.queryConfig) {
        hintEl.textContent = `请求第 ${state.pageCount} 页数据...`;
        const targetUrl = new URL(state.queryConfig.urlTemplate);
        const vars = { ...(state.queryConfig.variables || {}), count: 20 };
        if (state.nextCursor) vars.cursor = state.nextCursor;
        targetUrl.searchParams.set('variables', JSON.stringify(vars));
        if (state.queryConfig.features) targetUrl.searchParams.set('features', JSON.stringify(state.queryConfig.features));
        if (state.queryConfig.fieldToggles) targetUrl.searchParams.set('fieldToggles', JSON.stringify(state.queryConfig.fieldToggles));

        const reqHeaders = {
          'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'x-csrf-token': getCsrfToken(),
          ...state.headers
        };

        try {
          const res = await origFetch(targetUrl.toString(), { method: 'GET', headers: reqHeaders, credentials: 'include' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const { items, nextCursor, profile } = parseGraphQLTimeline(data);
          if (profile) updateProfileUI(profile);
          if (items && items.length > 0) addMediaItems(items);

          if (!nextCursor || nextCursor === state.nextCursor || items.length === 0) {
            hintEl.textContent = '已抓取至最底部，无更多推文。';
            break;
          }
          state.nextCursor = nextCursor;
        } catch (err) {
          hintEl.textContent = `接口限流，切换平滑滚动...`;
          window.scrollBy({ top: 1200, behavior: 'smooth' });
          await sleep(2500);
        }
      } else {
        hintEl.textContent = `滚动抓取第 ${state.pageCount} 页...`;
        window.scrollBy({ top: 1400, behavior: 'smooth' });
        await sleep(1800);
      }

      const delay = getAdaptiveDelay(state.pageCount);
      hintEl.textContent = `防风控等待 ${(delay / 1000).toFixed(1)}s 后翻页...`;
      await sleep(delay);
    }

    state.isScraping = false;
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    if (hintEl.textContent.includes('正在') || hintEl.textContent.includes('等待')) {
      hintEl.textContent = `抓取结束，共采集 ${state.capturedItems.size} 个媒体文件！`;
    }
  }

  function togglePause() {
    state.isPaused = !state.isPaused;
    const pauseBtn = document.getElementById('xmd-btn-pause');
    if (pauseBtn) pauseBtn.textContent = state.isPaused ? '继续' : '暂停';
  }

  function resetData() {
    state.isScraping = false;
    state.capturedItems.clear();
    state.nextCursor = null;
    state.pageCount = 0;
    const grid = document.getElementById('xmd-gallery-grid');
    if (grid) grid.innerHTML = '';
    updateStatsUI();
  }

  async function downloadAsZip() {
    const items = Array.from(state.capturedItems.values());
    if (items.length === 0) return;
    const JSZipLib = win.JSZip || window.JSZip;
    if (!JSZipLib) { alert('JSZip 依赖库未就绪'); return; }

    const zip = new JSZipLib();
    const handle = state.userProfile.screen_name || 'X_User';
    const folder = zip.folder(`${handle}_media`);
    const hintEl = document.getElementById('xmd-status-hint');
    const fillEl = document.getElementById('xmd-progress-fill');

    let completed = 0;
    const total = items.length;
    let idx = 0;

    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        const it = items[i];
        const ext = it.mediaType === 'video' ? 'mp4' : 'jpg';
        const name = `${handle}_${it.tweetId}_${String(i + 1).padStart(3, '0')}.${ext}`;
        try {
          const resp = await fetch(it.mediaUrl);
          const blob = await resp.blob();
          folder.file(name, blob);
        } catch (e) {}
        completed++;
        const pct = Math.round((completed / total) * 100);
        if (fillEl) fillEl.style.width = `${pct}%`;
        if (hintEl) hintEl.textContent = `正在打包: ${completed}/${total} (${pct}%)`;
      }
    }

    const workers = [];
    for (let w = 0; w < 3; w++) workers.push(worker());
    await Promise.all(workers);

    hintEl.textContent = '正在生成压缩包...';
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${handle}_media_${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    hintEl.textContent = `ZIP 打包完成！`;
  }

  function exportTxt() {
    const items = Array.from(state.capturedItems.values());
    if (items.length === 0) return;
    const urls = items.map(it => it.mediaUrl).join('\n');
    const handle = state.userProfile.screen_name || 'X_User';

    if (typeof GM_setClipboard !== 'undefined') GM_setClipboard(urls);
    else navigator.clipboard.writeText(urls);

    const blob = new Blob([urls], { type: 'text/plain;charset=utf-8' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = `${handle}_urls_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(u);

    const hintEl = document.getElementById('xmd-status-hint');
    if (hintEl) hintEl.textContent = '直链已复制到剪贴板并下载 TXT！';
  }

  // --- 信息流推文下载按钮 ---
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
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg>`;

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
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="#00ba7c"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
        setTimeout(() => {
          btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg>`;
        }, 2000);
      } else {
        if (popover) { popover.remove(); popover = null; }
        else {
          popover = createPopoverMenu(mediaItems, wrap, () => { popover?.remove(); popover = null; });
        }
      }
    };
  }

  function getMediaForTweet(tweetArticle, tweetId) {
    if (tweetId && state.tweetItemsMap.has(tweetId)) return state.tweetItemsMap.get(tweetId);

    const results = [];
    tweetArticle.querySelectorAll('img[src*="pbs.twimg.com/media/"]').forEach((img, idx) => {
      let orig = img.src;
      try { const u = new URL(orig); u.searchParams.set('name', 'orig'); orig = u.toString(); } catch (e) {}
      results.push({ id: `${tweetId}_img_${idx}`, tweetId, mediaType: 'image', mediaUrl: orig, thumbUrl: img.src });
    });

    tweetArticle.querySelectorAll('video').forEach((vid, idx) => {
      results.push({ id: `${tweetId}_vid_${idx}`, tweetId, mediaType: 'video', mediaUrl: vid.src, thumbUrl: vid.poster || '' });
    });
    return results;
  }

  function createPopoverMenu(items, parentWrap, onClose) {
    const pop = document.createElement('div');
    pop.className = 'xmd-popover-menu';
    let h = '<div style="display:flex; flex-direction:column; gap:6px; max-height:200px; overflow-y:auto;">';
    items.forEach((it, idx) => {
      h += `
        <div class="xmd-popover-item" data-idx="${idx}">
          <img class="xmd-popover-thumb" src="${it.thumbUrl || it.mediaUrl}" />
          <span style="font-size:12px; flex:1;">${it.mediaType === 'video' ? 'MP4 视频' : `原图 #${idx + 1}`}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </div>
      `;
    });
    h += '</div>';

    pop.innerHTML = `
      <div style="font-size:12px; font-weight:700; color:#71767b;">包含 ${items.length} 个媒体</div>
      ${h}
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { initUI(); initTweetObserver(); });
  } else {
    initUI();
    initTweetObserver();
  }
})();
