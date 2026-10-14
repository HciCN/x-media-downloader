/**
 * X-Media-Downloader - Injected Script (Main World)
 * 运行在 X.com 页面主世界上下文，负责截获 GraphQL 请求签名、鉴权头及解析推文媒体数据
 */
(function() {
  'use strict';

  if (window.__XMD_INJECTED__) return;
  window.__XMD_INJECTED__ = true;

  console.log('[XMD] Injected script initialized in Main World');

  // 存储捕获的凭证与 GraphQL 模板
  const capturedContext = {
    headers: {},
    queryConfigs: {},
    lastProfile: null,
    tweetsMap: new Map() // tweetId -> { mediaItems, text, user }
  };

  // 获取 Cookie 中的 CSRF Token
  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  // 拾取关键的 Twitter API 请求头
  function filterApiHeaders(headersObj) {
    const filtered = {};
    const targetKeys = [
      'authorization',
      'x-csrf-token',
      'x-client-transaction-id',
      'x-twitter-active-user',
      'x-twitter-auth-type',
      'x-twitter-client-language'
    ];
    for (const [k, v] of Object.entries(headersObj || {})) {
      const lower = k.toLowerCase();
      if (targetKeys.includes(lower)) {
        filtered[lower] = v;
      }
    }
    if (!filtered['x-csrf-token']) {
      const ct0 = getCsrfToken();
      if (ct0) filtered['x-csrf-token'] = ct0;
    }
    return filtered;
  }

  // 解析推文对象提取媒体与游标
  function parseGraphQLTimeline(json) {
    if (!json || typeof json !== 'object') return { items: [], nextCursor: null, profile: null };

    const items = [];
    let nextCursor = null;
    let userProfile = null;

    function walkEntries(obj) {
      if (!obj || typeof obj !== 'object') return;

      // 提取游标
      if (obj.entryType === 'TimelineTimelineCursor' || obj.__typename === 'TimelineTimelineCursor') {
        if (obj.cursorType === 'Bottom' || obj.cursorType === 'ShowMoreThreads') {
          if (obj.value && typeof obj.value === 'string') {
            nextCursor = obj.value;
          }
        }
      }

      // 提取推文
      if (obj.entryType === 'TimelineTimelineItem' || obj.__typename === 'TimelineTimelineItem') {
        const itemContent = obj.itemContent;
        if (itemContent && (itemContent.itemType === 'TimelineTweet' || itemContent.__typename === 'TimelineTweet')) {
          const tweetResult = itemContent.tweet_results?.result;
          if (tweetResult) {
            extractTweetData(tweetResult);
          }
        }
      }

      // 递归向下遍历
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
      if (!tweet) return;

      const legacy = tweet.legacy;
      if (!legacy) return;

      // 提取作者信息
      const userResult = tweet.core?.user_results?.result;
      if (userResult && !userProfile) {
        const uLegacy = userResult.legacy || {};
        userProfile = {
          rest_id: userResult.rest_id,
          name: uLegacy.name || '',
          screen_name: uLegacy.screen_name || '',
          avatar: uLegacy.profile_image_url_https ? uLegacy.profile_image_url_https.replace('_normal', '_400x400') : '',
          description: uLegacy.description || '',
          followers_count: uLegacy.followers_count || 0
        };
      }

      const tweetId = tweet.rest_id || legacy.id_str;
      const tweetText = legacy.full_text || '';
      const createdAt = legacy.created_at;
      const isRetweet = Boolean(legacy.retweeted_status_result || legacy.retweeted || tweetText.startsWith('RT @'));

      // 优先从 extended_entities 获取完整媒体列表
      let mediaEntities = legacy.extended_entities?.media || legacy.entities?.media || [];
      if (isRetweet && tweet.retweeted_status_result?.result) {
        const rt = tweet.retweeted_status_result.result;
        const rtLegacy = rt.legacy || {};
        mediaEntities = rtLegacy.extended_entities?.media || rtLegacy.entities?.media || mediaEntities;
      }

      const tweetMediaList = [];

      for (const m of mediaEntities) {
        const mediaId = m.id_str;
        const type = (m.type || '').toLowerCase(); // photo, video, animated_gif
        let mediaUrl = '';
        let mediaType = 'image';

        if (type === 'video' || type === 'animated_gif') {
          mediaType = 'video';
          const variants = m.video_info?.variants || [];
          // 筛选出 video/mp4 格式并按码率降序排序，取最高画质
          const mp4s = variants
            .filter(v => v.content_type === 'video/mp4')
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (mp4s.length > 0) {
            mediaUrl = mp4s[0].url;
          } else if (variants.length > 0) {
            mediaUrl = variants[0].url;
          }
        } else {
          // 图片：请求最高清原图
          mediaType = 'image';
          const rawUrl = m.media_url_https || m.media_url || '';
          if (rawUrl) {
            const u = new URL(rawUrl);
            u.searchParams.set('name', 'orig');
            mediaUrl = u.toString();
          }
        }

        if (mediaUrl) {
          const item = {
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
          items.push(item);
          tweetMediaList.push(item);
        }
      }

      if (tweetId && tweetMediaList.length > 0) {
        capturedContext.tweetsMap.set(tweetId, tweetMediaList);
      }
    }

    try {
      walkEntries(json);
    } catch (e) {
      console.warn('[XMD] Error traversing GraphQL response:', e);
    }

    return { items, nextCursor, profile: userProfile };
  }

  // --- Hook XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (!this._xmdHeaders) this._xmdHeaders = {};
    this._xmdHeaders[header] = value;
    return origSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.open = function(method, url) {
    this._xmdMethod = method;
    this._xmdUrl = typeof url === 'string' ? url : String(url);
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    const url = this._xmdUrl || '';
    if (url.includes('/i/api/graphql/')) {
      const filteredHeaders = filterApiHeaders(this._xmdHeaders || {});
      Object.assign(capturedContext.headers, filteredHeaders);

      try {
        const parsedUrl = new URL(url, window.location.origin);
        const match = parsedUrl.pathname.match(/\/graphql\/([^/]+)\/([a-zA-Z0-9_-]+)/);
        if (match) {
          const queryId = match[1];
          const queryName = match[2];
          const variables = parsedUrl.searchParams.get('variables');
          const features = parsedUrl.searchParams.get('features');
          const fieldToggles = parsedUrl.searchParams.get('fieldToggles');

          capturedContext.queryConfigs[queryName] = {
            queryId,
            queryName,
            urlTemplate: parsedUrl.origin + parsedUrl.pathname,
            variables: variables ? JSON.parse(variables) : null,
            features: features ? JSON.parse(features) : null,
            fieldToggles: fieldToggles ? JSON.parse(fieldToggles) : null
          };

          window.postMessage({
            source: 'XMD_INJECTED',
            type: 'QUERY_CONFIG_SNIFFED',
            payload: {
              queryName,
              config: capturedContext.queryConfigs[queryName],
              headers: capturedContext.headers
            }
          }, '*');
        }
      } catch (err) {}

      this.addEventListener('load', function() {
        try {
          if (this.status >= 200 && this.status < 300) {
            const data = JSON.parse(this.responseText);
            const { items, nextCursor, profile } = parseGraphQLTimeline(data);
            if (profile) capturedContext.lastProfile = profile;

            if (items.length > 0 || nextCursor || profile) {
              window.postMessage({
                source: 'XMD_INJECTED',
                type: 'RESPONSE_SNIFFED',
                payload: {
                  url,
                  items,
                  nextCursor,
                  profile
                }
              }, '*');
            }
          }
        } catch (e) {}
      });
    }

    return origSend.apply(this, arguments);
  };

  // --- Hook fetch ---
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    if (typeof url === 'string' && url.includes('/i/api/graphql/')) {
      const headers = {};
      if (init && init.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { headers[k] = v; });
        } else if (Array.isArray(init.headers)) {
          init.headers.forEach(([k, v]) => { headers[k] = v; });
        } else {
          Object.assign(headers, init.headers);
        }
      }
      Object.assign(capturedContext.headers, filterApiHeaders(headers));

      try {
        const parsedUrl = new URL(url, window.location.origin);
        const match = parsedUrl.pathname.match(/\/graphql\/([^/]+)\/([a-zA-Z0-9_-]+)/);
        if (match) {
          const queryId = match[1];
          const queryName = match[2];
          const variables = parsedUrl.searchParams.get('variables');
          const features = parsedUrl.searchParams.get('features');
          const fieldToggles = parsedUrl.searchParams.get('fieldToggles');

          capturedContext.queryConfigs[queryName] = {
            queryId,
            queryName,
            urlTemplate: parsedUrl.origin + parsedUrl.pathname,
            variables: variables ? JSON.parse(variables) : null,
            features: features ? JSON.parse(features) : null,
            fieldToggles: fieldToggles ? JSON.parse(fieldToggles) : null
          };

          window.postMessage({
            source: 'XMD_INJECTED',
            type: 'QUERY_CONFIG_SNIFFED',
            payload: {
              queryName,
              config: capturedContext.queryConfigs[queryName],
              headers: capturedContext.headers
            }
          }, '*');
        }
      } catch (err) {}
    }

    const response = await origFetch.apply(this, arguments);

    if (typeof url === 'string' && url.includes('/i/api/graphql/')) {
      try {
        const clone = response.clone();
        clone.json().then(data => {
          const { items, nextCursor, profile } = parseGraphQLTimeline(data);
          if (profile) capturedContext.lastProfile = profile;
          if (items.length > 0 || nextCursor || profile) {
            window.postMessage({
              source: 'XMD_INJECTED',
              type: 'RESPONSE_SNIFFED',
              payload: {
                url,
                items,
                nextCursor,
                profile
              }
            }, '*');
          }
        }).catch(() => {});
      } catch (e) {}
    }

    return response;
  };

  // --- 接收 Content Script 传来的操作指令 ---
  window.addEventListener('message', async function(ev) {
    if (ev.source !== window || !ev.data || ev.data.source !== 'XMD_CONTENT') return;

    const { type, requestId, payload } = ev.data;

    // 指令 1: 使用主世界 session 和 headers 模拟发送 GraphQL 请求
    if (type === 'EXECUTE_GRAPHQL_FETCH') {
      const { endpointUrl, variables, features, fieldToggles } = payload;
      try {
        const targetUrl = new URL(endpointUrl);
        if (variables) targetUrl.searchParams.set('variables', JSON.stringify(variables));
        if (features) targetUrl.searchParams.set('features', JSON.stringify(features));
        if (fieldToggles) targetUrl.searchParams.set('fieldToggles', JSON.stringify(fieldToggles));

        const reqHeaders = {
          'content-type': 'application/json',
          'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'x-csrf-token': getCsrfToken(),
          ...capturedContext.headers
        };

        const res = await origFetch(targetUrl.toString(), {
          method: 'GET',
          headers: reqHeaders,
          credentials: 'include'
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();
        const parsed = parseGraphQLTimeline(data);

        window.postMessage({
          source: 'XMD_INJECTED',
          type: 'EXECUTE_GRAPHQL_FETCH_REPLY',
          requestId,
          success: true,
          data: parsed
        }, '*');
      } catch (err) {
        window.postMessage({
          source: 'XMD_INJECTED',
          type: 'EXECUTE_GRAPHQL_FETCH_REPLY',
          requestId,
          success: false,
          error: err.message
        }, '*');
      }
    }

    // 指令 2: 平滑滚动页面
    if (type === 'SCROLL_WINDOW') {
      window.scrollBy({ top: payload.distance || 1500, behavior: 'smooth' });
    }
  });

  window.postMessage({
    source: 'XMD_INJECTED',
    type: 'INJECTED_READY'
  }, '*');

})();
