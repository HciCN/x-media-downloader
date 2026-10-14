#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
X-Media-Downloader - 安卓远程流媒体与全球公网穿透服务 (方案三)
1. 自动挂载与发现本地已下载的所有博主推文与媒体库 (免去任何手动同步)
2. 内置 Cloudflare 快速临时安全隧道，提供全球可访问的 HTTPS 域名与扫码直达
3. 纯 Python 标准库编写，零依赖，开箱即用，支持移动端 HTTP 206 Range 视频分片秒开快进
"""

import sys
import os
import shutil
import socket
import re
import json
import urllib.parse
import urllib.request
import threading
import subprocess
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# 彻底禁用 Python 字节码缓存生成，避免生成 __pycache__ 导致 Chrome 扩展加载报错
sys.dont_write_bytecode = True

# 启动时自动检查并清除可能残留的 __pycache__ 目录
_curr_dir = os.path.dirname(os.path.abspath(__file__))
_pycache_dir = os.path.join(_curr_dir, '__pycache__')
if os.path.exists(_pycache_dir):
    try:
        shutil.rmtree(_pycache_dir, ignore_errors=True)
    except Exception:
        pass

# 兼容 Windows 控制台编码
if sys.platform.startswith('win'):
    try:
        os.system('')  # 启用 VT100 控制台转义序列
    except Exception:
        pass
    try:
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
        if hasattr(sys.stderr, 'reconfigure'):
            sys.stderr.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
    except Exception:
        pass

PORT = 8899
DATA_FILE = os.path.join(_curr_dir, 'remote_tasks_db.json')
LIBRARY_CONFIG_FILE = os.path.join(_curr_dir, 'library_config.json')

def get_windows_download_dir():
    """自动获取 Windows 系统真实的默认下载文件夹路径"""
    if sys.platform.startswith('win'):
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
            val, _ = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")
            p = os.path.expandvars(val)
            if os.path.exists(p):
                return p
        except Exception:
            pass
    home = os.path.expanduser('~')
    for cand in ['F:\\下载', os.path.join(home, 'Downloads'), os.path.join(home, '下载')]:
        if os.path.exists(cand):
            return cand
    return _curr_dir

DL_DIR = get_windows_download_dir()

def load_library_config():
    """读取所有已配置的片库文件夹路径 (Jellyfin 多片库挂载模式)"""
    default_libs = [DL_DIR]
    if not os.path.exists(LIBRARY_CONFIG_FILE):
        try:
            with open(LIBRARY_CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump({"libraries": default_libs}, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        return default_libs

    try:
        with open(LIBRARY_CONFIG_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            libs = data.get('libraries', [])
            cleaned = []
            for item in libs:
                if not item or not isinstance(item, str):
                    continue
                p = os.path.abspath(os.path.expandvars(os.path.expanduser(item.strip())))
                if p and p not in cleaned:
                    cleaned.append(p)
            if not cleaned:
                cleaned = default_libs
            return cleaned
    except Exception:
        return default_libs

def save_library_config(libs):
    """持久化保存片库文件夹配置"""
    try:
        with open(LIBRARY_CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump({"libraries": libs}, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f">> 保存片库配置失败: {e}")

_IMAGE_CACHE = {}

def fetch_proxy_image(url):
    """通过本机网络代理拉取 Twitter/X 图像并缓存，解决手机端直连被屏蔽的问题"""
    if not url:
        return None, None
    if url in _IMAGE_CACHE:
        return _IMAGE_CACHE[url]
    try:
        req = urllib.request.Request(
            url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://x.com/'
            }
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = resp.read()
            c_type = resp.headers.get('Content-Type', 'image/jpeg')
            _IMAGE_CACHE[url] = (data, c_type)
            if len(_IMAGE_CACHE) > 600:
                _IMAGE_CACHE.pop(next(iter(_IMAGE_CACHE)))
            return data, c_type
    except Exception:
        return None, None

def generate_avatar_svg(name):
    """为无头像博主自动生成高质感绚丽彩色首字母矢量头像"""
    clean = re.sub(r'[^a-zA-Z0-9\u4e00-\u9fa5]', '', name or 'X')
    char = (clean[0] if clean else 'X').upper()
    colors = [
        ('#1d9bf0', '#0a6ab7'),
        ('#7928ca', '#4c1d95'),
        ('#ff0080', '#be185d'),
        ('#f5a623', '#d97706'),
        ('#10b981', '#047857'),
        ('#06b6d4', '#0e7490'),
        ('#ec4899', '#9d174d'),
        ('#8b5cf6', '#6d28d9'),
    ]
    idx = abs(hash(name or 'X')) % len(colors)
    c1, c2 = colors[idx]
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
  <defs>
    <linearGradient id="g_{idx}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="{c1}"/>
      <stop offset="100%" stop-color="{c2}"/>
    </linearGradient>
  </defs>
  <rect width="120" height="120" rx="60" fill="url(#g_{idx})"/>
  <text x="50%" y="54%" font-size="52" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-weight="800" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">{char}</text>
</svg>"""
    return svg.encode('utf-8')

def scan_downloaded_media():
    """
    自动扫描所有已配置的媒体库文件夹 (默认包括 Windows 下载目录及用户自定义挂载的文件夹)
    智能识别视频 (.mp4, .webm, .mkv, .mov, .ts, .avi) 与图片 (.jpg, .jpeg, .png, .gif, .webp)
    按子目录聚合为片库博主/合集专辑，支持像 Jellyfin / Emby 一样即刻串流
    """
    tasks = []
    items_map = {}
    media_exts = {'.mp4', '.webm', '.mkv', '.mov', '.ts', '.avi', '.jpg', '.jpeg', '.png', '.gif', '.webp'}
    video_exts = {'.mp4', '.webm', '.mkv', '.mov', '.ts', '.avi'}

    all_libs = load_library_config()

    for lib_idx, base_dir in enumerate(all_libs):
        if not os.path.exists(base_dir):
            continue

        try:
            for root, dirs, files in os.walk(base_dir):
                rel = os.path.relpath(root, base_dir)
                depth = 0 if rel == '.' else len(rel.split(os.sep))
                if depth > 2:
                    continue

                media_files = [f for f in files if os.path.splitext(f.lower())[1] in media_exts]
                if not media_files:
                    continue

                folder_name = os.path.basename(root) if rel != '.' else os.path.basename(base_dir)
                if not folder_name:
                    folder_name = f'Library_{lib_idx}'

                # 提取博主名或合集名
                blogger = re.sub(r'(_media|_x_media|_selected)$', '', folder_name, flags=re.I)
                if blogger.lower() == 'unknown' and 'x-media' in rel.lower():
                    blogger = 'X_Media_Captured'

                clean_blogger = re.sub(r'[^a-zA-Z0-9_\u4e00-\u9fa5]', '', blogger) or f'Lib{lib_idx}'
                task_id = f'lib{lib_idx}_' + clean_blogger
                items = []

                for idx, f in enumerate(sorted(media_files, reverse=True)):
                    ext = os.path.splitext(f.lower())[1]
                    m_type = 'video' if ext in video_exts else 'image'
                    tm = re.search(r'_(\d{15,22})_', f)
                    tweet_id = tm.group(1) if tm else ''

                    file_rel = (os.path.join(rel, f) if rel != '.' else f).replace('\\', '/')
                    if file_rel.startswith('./'):
                        file_rel = file_rel[2:]

                    full_path = os.path.join(root, f)
                    size_mb = round(os.path.getsize(full_path) / (1024 * 1024), 1) if os.path.exists(full_path) else 0

                    stream_url = f'/media_stream/{lib_idx}/' + urllib.parse.quote(file_rel)
                    items.append({
                        'id': f'{task_id}_{idx}',
                        'mediaType': m_type,
                        'tweetId': tweet_id,
                        'tweetText': f'已归档媒体: {f} ({size_mb} MB)',
                        'mediaUrl': stream_url,
                        'thumbUrl': stream_url if m_type == 'image' else '',
                        'download_status': 'completed'
                    })

                task_title = f'@{blogger}' if rel != '.' else f'📁 {os.path.basename(base_dir)}'
                tasks.append({
                    'id': task_id,
                    'task_name': f'{task_title} 的媒体库 (本地库)',
                    'x_name': blogger,
                    'x_screen_name': clean_blogger,
                    'x_avatar': f'/api/avatar_svg?name={urllib.parse.quote(clean_blogger)}',
                    'status': 'completed',
                    'media_count': len(items),
                    'completed_count': len(items),
                    'created_at': int(os.path.getmtime(root) * 1000)
                })
                items_map[task_id] = items
        except Exception as e:
            print(f">> 扫描片库目录 [{base_dir}] 失败: {e}")

    return tasks, items_map

def load_merged_db():
    """
    读取并净化片库数据库 (参考 Jellyfin / Plex 刮削与整理机制):
    1. 以博主用户名 (handle) 为唯一键严格去重归并，杜绝重复与碎片
    2. 彻底剔除历史孤儿任务、空任务 (如 " 的媒体库")
    3. 自动同步持久化写入 remote_tasks_db.json，永除后患
    """
    stored_db = {'tasks': [], 'items': {}}
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, 'r', encoding='utf-8') as f:
                stored_db = json.load(f)
        except Exception:
            pass

    scanned_tasks, scanned_items = scan_downloaded_media()

    # 以博主小写 handle 为 key 进行统一去重
    blogger_map = {}
    blogger_items_map = {}

    # 1. 优先载入本地真实下载文件夹 (置信度最高)
    for t in scanned_tasks:
        handle = (t.get('x_screen_name') or '').strip()
        if not handle:
            continue
        h_key = handle.lower()
        blogger_map[h_key] = t
        blogger_items_map[t['id']] = scanned_items.get(t['id'], [])

    # 2. 归并扩展抓取的任务
    for t in stored_db.get('tasks', []):
        handle = (t.get('x_screen_name') or '').strip()
        if not handle:
            m = re.match(r'@?([a-zA-Z0-9_]+)\s*(?:的媒体库|的推文)?', t.get('task_name', ''))
            if m:
                handle = m.group(1)
                t['x_screen_name'] = handle
                if not t.get('x_name'):
                    t['x_name'] = handle
        # 严格过滤无效幽灵任务
        if not handle or handle.lower() in ('x_user', 'user', 'unknown', 'none') or not t.get('media_count'):
            continue
        if '的媒体库' == t.get('task_name', '').strip():
            continue

        h_key = handle.lower()
        if h_key in blogger_map:
            # 本地已扫描出该博主，保留本地下载置顶标记
            existing_task = blogger_map[h_key]
            if t.get('x_avatar') and not t.get('x_avatar', '').startswith('/api/avatar_svg'):
                existing_task['x_avatar'] = t['x_avatar']
        else:
            name = t.get('x_name') or t.get('x_screen_name') or handle
            if not t.get('x_avatar') or 'twitter.3.ico' in t.get('x_avatar', ''):
                t['x_avatar'] = f"/api/avatar_svg?name={urllib.parse.quote(name)}"
            elif t.get('x_avatar', '').startswith('http') and ('twimg.com' in t.get('x_avatar', '') or 'twitter.com' in t.get('x_avatar', '')):
                t['x_avatar'] = f"/api/proxy_image?url={urllib.parse.quote(t['x_avatar'])}"

            blogger_map[h_key] = t
            blogger_items_map[t['id']] = stored_db.get('items', {}).get(t['id'], [])

    # 针对未离线下载的媒体文件，自动补齐代理地址，确保手机端无需 VPN 也能流畅加载
    for tid, items in blogger_items_map.items():
        for item in items:
            m_url = item.get('mediaUrl', '')
            t_url = item.get('thumbUrl', '')
            if m_url.startswith('http') and ('twimg.com' in m_url or 'twitter.com' in m_url):
                if item.get('mediaType') == 'image':
                    item['mediaUrl'] = f"/api/proxy_image?url={urllib.parse.quote(m_url)}"
                else:
                    item['mediaUrl'] = f"/api/proxy_media?url={urllib.parse.quote(m_url)}"
            if t_url.startswith('http') and ('twimg.com' in t_url or 'twitter.com' in t_url):
                item['thumbUrl'] = f"/api/proxy_image?url={urllib.parse.quote(t_url)}"

    clean_tasks = list(blogger_map.values())
    # 排序：本地已下载排在最前，其次按媒体数量降序
    clean_tasks.sort(key=lambda x: (0 if '本地已下载' in x.get('task_name', '') else 1, -x.get('media_count', 0)))

    # 保存净化后的纯净数据库，清理旧的垃圾记录
    try:
        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump({'tasks': clean_tasks, 'items': blogger_items_map}, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

    return {'tasks': clean_tasks, 'items': blogger_items_map}

def save_remote_db(data):
    try:
        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[DB] 保存失败: {e}")

def get_lan_ip():
    """智能获取真实物理网卡 IPv4，过滤 TUN/VPN 虚拟网卡"""
    candidates = []
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith(('127.', '169.254.', '198.18.', '198.19.')):
                candidates.append(ip)
    except Exception:
        pass

    for gw in ['192.168.0.1', '192.168.1.1', '192.168.31.1', '192.168.123.1', '10.0.0.1']:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((gw, 80))
            ip = s.getsockname()[0]
            s.close()
            if not ip.startswith(('127.', '169.254.', '198.18.', '198.19.')):
                if ip not in candidates:
                    candidates.insert(0, ip)
                else:
                    candidates.remove(ip)
                    candidates.insert(0, ip)
                break
        except Exception:
            pass

    for ip in candidates:
        if ip.startswith('192.168.'):
            return ip

    return candidates[0] if candidates else '127.0.0.1'

class DualStackServer(ThreadingHTTPServer):
    """支持 IPv6 与 IPv4 双栈 (Dual-Stack) 的并发 HTTP 服务，确保 localhost、127.0.0.1 及局域网 IP 均可无缝访问"""
    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except Exception:
            pass
        super().server_bind()

class VideoStreamingHTTPRequestHandler(SimpleHTTPRequestHandler):
    """
    支持 HTTP 206 Partial Content (Range 请求) 与移动端远程数据 API 的流媒体处理器
    """
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 根路径智能根据设备重定向 (手机自动直达抖音全屏流，电脑进入控制台)
        if path in ('', '/', '/index.html'):
            user_agent = self.headers.get('User-Agent', '').lower()
            is_mobile = any(k in user_agent for k in ('mobile', 'android', 'iphone', 'ipad', 'harmony'))
            target = '/mobile.html' if is_mobile else '/dashboard.html'
            self.send_response(302)
            self.send_header('Location', target)
            self.end_headers()
            return

        if path in ('/mobile', '/douyin'):
            self.send_response(302)
            self.send_header('Location', '/mobile.html')
            self.end_headers()
            return

        # API: 获取任务列表 (自动合并本地已下载博主)
        if path == '/api/tasks':
            db = load_merged_db()
            body = json.dumps({'success': True, 'tasks': db.get('tasks', [])}, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return

        # API: 获取单任务详情
        if path == '/api/task_detail':
            qs = urllib.parse.parse_qs(parsed.query)
            task_id = qs.get('id', [''])[0]
            db = load_merged_db()
            task = next((t for t in db.get('tasks', []) if t.get('id') == task_id), None)
            items = db.get('items', {}).get(task_id, [])
            if not task and db.get('tasks'):
                task = db['tasks'][0]
                items = db.get('items', {}).get(task.get('id'), [])

            body = json.dumps({'success': True, 'task': task, 'items': items}, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return

        # APK 安卓软件安装包下载: /XMediaViewer.apk 或 /app
        if path in ('/app', '/download_app'):
            self.send_response(302)
            self.send_header('Location', '/XMediaViewer.apk')
            self.end_headers()
            return

        if path == '/XMediaViewer.apk':
            apk_path = os.path.join(_curr_dir, 'XMediaViewer.apk')
            if not os.path.exists(apk_path):
                # 备用路径寻找
                alt = os.path.join(os.path.dirname(_curr_dir), 'x-media-app', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
                if os.path.exists(alt):
                    apk_path = alt
            if os.path.exists(apk_path):
                f_size = os.path.getsize(apk_path)
                self.send_response(200)
                self.send_header('Content-Type', 'application/vnd.android.package-archive')
                self.send_header('Content-Length', str(f_size))
                self.send_header('Content-Disposition', 'attachment; filename="XMediaViewer.apk"')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                with open(apk_path, 'rb') as f:
                    shutil.copyfileobj(f, self.wfile, length=64*1024)
                return
            else:
                self.send_error(404, "APK not found")
                return

        # 矢量彩色首字母头像: /api/avatar_svg?name=...
        if path == '/api/avatar_svg':
            qs = urllib.parse.parse_qs(parsed.query)
            name = qs.get('name', ['X'])[0]
            svg_data = generate_avatar_svg(name)
            self.send_response(200)
            self.send_header('Content-Type', 'image/svg+xml; charset=utf-8')
            self.send_header('Content-Length', str(len(svg_data)))
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(svg_data)
            return

        # 图像代理中继 (解决手机端无法直连 Twitter pbs.twimg.com 头像与图片的问题)
        if path == '/api/proxy_image':
            qs = urllib.parse.parse_qs(parsed.query)
            target_url = qs.get('url', [''])[0]
            data, c_type = fetch_proxy_image(target_url)
            if data:
                self.send_response(200)
                self.send_header('Content-Type', c_type or 'image/jpeg')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'public, max-age=86400')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
                return
            else:
                svg_data = generate_avatar_svg('X')
                self.send_response(200)
                self.send_header('Content-Type', 'image/svg+xml; charset=utf-8')
                self.send_header('Content-Length', str(len(svg_data)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(svg_data)
                return

        # 视频代理中继 (针对未下载推文视频进行中继)
        if path == '/api/proxy_media':
            qs = urllib.parse.parse_qs(parsed.query)
            target_url = qs.get('url', [''])[0]
            if not target_url:
                self.send_error(400, "Missing URL")
                return
            try:
                headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Referer': 'https://x.com/'
                }
                range_header = self.headers.get('Range')
                if range_header:
                    headers['Range'] = range_header

                req = urllib.request.Request(target_url, headers=headers)
                with urllib.request.urlopen(req, timeout=12) as resp:
                    status = getattr(resp, 'status', 200)
                    self.send_response(status)
                    for k, v in resp.headers.items():
                        if k.lower() in ('content-type', 'content-length', 'content-range', 'accept-ranges'):
                            self.send_header(k, v)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    shutil.copyfileobj(resp, self.wfile, length=128*1024)
                return
            except Exception as e:
                self.send_error(502, f"Proxy media error: {e}")
                return

        # API: 重新扫描并净化本地片库 (Jellyfin 重新扫描片库)
        if path == '/api/rescan':
            db = load_merged_db()
            body = json.dumps({'success': True, 'tasks': db.get('tasks', [])}, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return

        # API: 电脑局域网信息
        if path == '/api/lan_info':
            lan_ip = get_lan_ip()
            body = json.dumps({'ip': lan_ip, 'port': self.server.server_port}, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return

        # API: 获取所有已挂载的媒体库文件夹 (Jellyfin 多片库模式)
        if path == '/api/libraries':
            libs = load_library_config()
            lib_info = []
            for idx, p in enumerate(libs):
                lib_info.append({
                    'id': idx,
                    'path': p,
                    'exists': os.path.exists(p),
                    'is_default': (os.path.normpath(p) == os.path.normpath(DL_DIR))
                })
            body = json.dumps({'success': True, 'libraries': lib_info}, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return

        # API: 服务器运行状态与统计 (Web 控制总台)
        if path == '/api/server_stats':
            db = load_merged_db()
            tasks = db.get('tasks', [])
            items_map = db.get('items', {})
            total_items = sum(len(v) for v in items_map.values())
            video_count = 0
            image_count = 0
            for items in items_map.values():
                for it in items:
                    if it.get('mediaType') == 'video':
                        video_count += 1
                    else:
                        image_count += 1
            libs = load_library_config()
            lib_info = []
            for idx, p in enumerate(libs):
                lib_info.append({
                    'id': idx,
                    'path': p,
                    'exists': os.path.exists(p),
                    'is_default': (os.path.normpath(p) == os.path.normpath(DL_DIR))
                })
            lan_ip = get_lan_ip()
            port = self.server.server_port
            mobile_url = f"http://{lan_ip}:{port}/mobile.html"
            tunnel_url = global_tunnel_url
            tunnel_mobile_url = f"{tunnel_url}mobile.html" if tunnel_url else None
            
            body = json.dumps({
                'success': True,
                'server_status': 'running',
                'lan_ip': lan_ip,
                'port': port,
                'local_url': f"http://127.0.0.1:{port}/",
                'localhost_url': f"http://127.0.0.1:{port}/dashboard.html",
                'lan_url': f"http://{lan_ip}:{port}/",
                'mobile_url': mobile_url,
                'tunnel_url': tunnel_url,
                'tunnel_mobile_url': tunnel_mobile_url,
                'task_count': len(tasks),
                'total_media': total_items,
                'video_count': video_count,
                'image_count': image_count,
                'library_count': len(libs),
                'libraries': lib_info
            }, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return

        # API: 动态二维码生成 (手机扫码直连)
        if path == '/api/qrcode':
            qs = urllib.parse.parse_qs(parsed.query)
            target = qs.get('url', [''])[0]
            if not target:
                lan_ip = get_lan_ip()
                target = f"http://{lan_ip}:{self.server.server_port}/mobile.html"
            try:
                import io
                import qrcode
                img = qrcode.make(target)
                buf = io.BytesIO()
                img.save(buf, format='PNG')
                qr_bytes = buf.getvalue()
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(qr_bytes)))
                self.send_header('Cache-Control', 'max-age=60')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(qr_bytes)
                return
            except Exception as e:
                self.send_error(500, f"QR generation failed: {e}")
                return

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == '/api/sync_task':
            try:
                length = int(self.headers.get('Content-Length', 0))
                raw_body = self.rfile.read(length).decode('utf-8')
                payload = json.loads(raw_body)
                task = payload.get('task')
                items = payload.get('items', [])

                if task and task.get('id'):
                    task_id = task['id']
                    db = load_merged_db()
                    existing_idx = next((i for i, t in enumerate(db['tasks']) if t.get('id') == task_id), -1)
                    if existing_idx >= 0:
                        db['tasks'][existing_idx] = task
                    else:
                        db['tasks'].insert(0, task)
                    db.setdefault('items', {})[task_id] = items
                    save_remote_db(db)
                    print(f"  [+] 成功同步任务: @{task.get('x_screen_name', '')} (含 {len(items)} 条媒体)")

                resp = json.dumps({'success': True}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(resp)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(resp)
            except Exception as e:
                self.send_error(500, str(e))
            return

        # API: 自定义添加外部片库文件夹
        if path == '/api/libraries/add':
            try:
                length = int(self.headers.get('Content-Length', 0))
                req_data = json.loads(self.rfile.read(length).decode('utf-8'))
                new_path = req_data.get('path', '').strip()
                if not new_path:
                    self.send_error(400, "路径不能为空")
                    return
                new_path = os.path.abspath(os.path.expandvars(os.path.expanduser(new_path)))
                if not os.path.exists(new_path):
                    body = json.dumps({'success': False, 'message': f'文件夹不存在: {new_path}'}, ensure_ascii=False).encode('utf-8')
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                libs = load_library_config()
                norm_new = os.path.normpath(new_path)
                if not any(os.path.normpath(p) == norm_new for p in libs):
                    libs.append(new_path)
                    save_library_config(libs)
                # 重新扫描片库
                db = load_merged_db()
                body = json.dumps({'success': True, 'message': f'成功添加媒体库: {new_path}', 'libraries': libs}, ensure_ascii=False).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
                return
            except Exception as e:
                self.send_error(500, str(e))
                return

        # API: 移除外部片库文件夹
        if path == '/api/libraries/remove':
            try:
                length = int(self.headers.get('Content-Length', 0))
                req_data = json.loads(self.rfile.read(length).decode('utf-8'))
                target_path = req_data.get('path', '').strip()
                libs = load_library_config()
                norm_target = os.path.normpath(target_path)
                libs = [p for p in libs if os.path.normpath(p) != norm_target]
                save_library_config(libs)
                # 重新扫描片库
                db = load_merged_db()
                body = json.dumps({'success': True, 'message': '已成功移除该片库', 'libraries': libs}, ensure_ascii=False).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
                return
            except Exception as e:
                self.send_error(500, str(e))
                return

        self.send_error(404, "Unknown API")

    def send_head(self):
        # 处理本地媒体流映射: /media_stream/<lib_idx>/<rel_path> 或兼容老版 /media_stream/<rel_path>
        if self.path.startswith('/media_stream/'):
            raw = self.path[len('/media_stream/'):]
            parts = raw.split('/', 1)
            libs = load_library_config()
            file_path = None
            if len(parts) == 2 and parts[0].isdigit():
                lib_idx = int(parts[0])
                clean_rel = urllib.parse.unquote(parts[1])
                if lib_idx < len(libs):
                    cand = os.path.join(libs[lib_idx], clean_rel)
                    if os.path.exists(cand):
                        file_path = cand

            if not file_path:
                clean_rel = urllib.parse.unquote(raw)
                for base in libs:
                    cand = os.path.join(base, clean_rel)
                    if os.path.exists(cand):
                        file_path = cand
                        break
                if not file_path:
                    file_path = os.path.join(DL_DIR, clean_rel)
        else:
            file_path = self.translate_path(self.path)

        if os.path.isdir(file_path):
            return super().send_head()

        try:
            f = open(file_path, 'rb')
        except OSError:
            self.send_error(404, "File not found")
            return None

        range_header = self.headers.get('Range')
        if not range_header or not range_header.startswith('bytes='):
            return super().send_head()

        fs = os.fstat(f.fileno())
        total_length = fs.st_size

        match = re.match(r'bytes=(\d+)-(\d*)', range_header)
        if not match:
            return super().send_head()

        start_str, end_str = match.groups()
        start = int(start_str)
        end = int(end_str) if end_str else total_length - 1

        if start >= total_length:
            self.send_error(416, "Requested Range Not Satisfiable")
            f.close()
            return None

        end = min(end, total_length - 1)
        content_length = end - start + 1

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(file_path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{total_length}")
        self.send_header("Content-Length", str(content_length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        f.seek(start)
        return f

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

# 全局存储 Cloudflare 隧道进程与公共 URL
global_tunnel_proc = None
global_tunnel_url = None

def start_cloudflare_tunnel(port):
    """启动 Cloudflare 全球快速安全临时隧道 (方案三)"""
    global global_tunnel_proc, global_tunnel_url
    cf_bin = os.path.join(_curr_dir, 'cloudflared.exe')
    if not os.path.exists(cf_bin):
        return None

    cmd = [cf_bin, 'tunnel', '--url', f'http://127.0.0.1:{port}']
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, bufsize=1)
        global_tunnel_proc = proc

        start = time.time()
        while time.time() - start < 18:
            line = proc.stderr.readline()
            if not line:
                continue
            m = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
            if m:
                global_tunnel_url = m.group(0) + '/'
                def drain_pipe():
                    try:
                        for _ in proc.stderr:
                            pass
                    except Exception:
                        pass
                threading.Thread(target=drain_pipe, daemon=True).start()
                return global_tunnel_url
    except Exception as e:
        print(f">> Cloudflare 隧道启动异常: {e}")

    return None

def print_banner(lan_ip, port, tunnel_url, scanned_tasks):
    local_url = f"http://127.0.0.1:{port}/"
    lan_url = f"http://{lan_ip}:{port}/"
    mobile_local_url = f"http://{lan_ip}:{port}/mobile.html"
    mobile_tunnel_url = f"{tunnel_url}mobile.html" if tunnel_url else None
    qr_target = mobile_tunnel_url if mobile_tunnel_url else mobile_local_url

    print("\n" + "=" * 68)
    print("  🚀 X-Media-Downloader 本地控制总台 & 局域网/公网流媒体服务已就绪！")
    print("=" * 68)

    print("\n  💻 [电脑本机控制总台 (双击已自动在默认浏览器中打开)]：")
    print(f"  👉 本机总台直达 : \033[92mhttp://127.0.0.1:{port}/dashboard.html\033[0m")
    print(f"  👉 本机备用直达 : http://localhost:{port}/dashboard.html")

    print("\n  📶 [手机与同局域网设备直连 (需在同一 Wi-Fi)]：")
    print(f"  📱 手机抖音刷片 : \033[96m{mobile_local_url}\033[0m")
    print(f"  💻 局域网控制台 : {lan_url}dashboard.html")
    print(f"  📲 安卓全屏软件 (APK): \033[93mhttp://127.0.0.1:{port}/XMediaViewer.apk\033[0m")

    if tunnel_url:
        print("\n  🌐 [方案三：全球公网 HTTPS 直达 (免 Wi-Fi 限制 / 4G/5G 随时刷)]：")
        print(f"  📱 手机抖音刷片 : \033[92m{mobile_tunnel_url}\033[0m")
        print(f"  💻 公网管理看板 : {tunnel_url}dashboard.html")
        print(f"  📲 安卓全屏软件 (公网APK): \033[93m{tunnel_url}XMediaViewer.apk\033[0m")
    else:
        print("\n  🌐 [方案三：全球公网 HTTPS 隧道正在后台连接中...无需等待，本地已可正常秒开]")

    # 尝试打印 ASCII 二维码 (手机直接扫码打开抖音短视频流)
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(qr_target)
        qr.make(fit=True)
        print("\n  📱 [手机微信 / 相机扫码直达抖音全屏短视频流]：")
        qr.print_ascii(invert=True)
    except Exception:
        pass

    print("\n  📁 [已挂载的媒体库文件夹 (Jellyfin 多片库模式)]：")
    libs = load_library_config()
    for idx, lib in enumerate(libs, 1):
        status = "✅ 正常" if os.path.exists(lib) else "⚠️ 路径不存在"
        tag = " (系统默认)" if os.path.normpath(lib) == os.path.normpath(DL_DIR) else " (自定义添加)"
        print(f"     [{idx}] {lib}{tag} - {status}")
    print("     💡 提示：在 Web 控制总台【📁 媒体库管理】中可随时一键添加/管理任意文件夹！")

    print("\n  🎬 [扫描到的合集与任务]：")
    if scanned_tasks:
        for t in scanned_tasks:
            print(f"     ✅ {t['task_name']} (含 {t['media_count']} 个媒体文件)")
    else:
        print("     ℹ️ 暂未扫描到媒体文件夹，放入 MP4/图片文件后在控制台点击【重新扫描片库】即可。")

    print("\n  💡 使用小贴士：")
    print("  1. 双击脚本已自动在您的默认浏览器打开 Web 控制总台，可直接在控制总台管理片库与查看统计；")
    print("  2. 手机想【真正 100% 全屏免浏览器地址栏】：手机扫码或下载安装【XMediaViewer.apk】！")
    print("  3. 彻底免去把视频拷贝到手机的繁琐步骤，零占用手机内存！")
    print("\n  （按 Ctrl + C 可随时安全停止服务）")
    print("=" * 68 + "\n")

def main():
    os.chdir(_curr_dir)

    import argparse
    parser = argparse.ArgumentParser(description='X-Media-Downloader Remote Streaming Server')
    parser.add_argument('--add-dir', help='添加自定义媒体库文件夹路径并退出')
    parser.add_argument('--list-dirs', action='store_true', help='列出当前已配置的媒体库文件夹并退出')
    parser.add_argument('--no-browser', action='store_true', help='启动时不自动打开浏览器')
    args, _ = parser.parse_known_args()

    if args.add_dir:
        target = os.path.abspath(os.path.expandvars(os.path.expanduser(args.add_dir.strip())))
        if not os.path.exists(target):
            print(f"❌ 错误: 目标文件夹不存在: {target}")
            return
        libs = load_library_config()
        norm_target = os.path.normpath(target)
        if not any(os.path.normpath(p) == norm_target for p in libs):
            libs.append(target)
            save_library_config(libs)
            print(f"✅ 成功添加媒体库路径: {target}")
            print(f"当前全部媒体库 ({len(libs)} 个):")
            for i, p in enumerate(libs, 1):
                print(f"   [{i}] {p}")
        else:
            print(f"ℹ️ 该路径已在媒体库配置中: {target}")
        return

    if args.list_dirs:
        libs = load_library_config()
        print(f"当前已配置的媒体库文件夹 ({len(libs)} 个):")
        for i, p in enumerate(libs, 1):
            status = "存在" if os.path.exists(p) else "不存在"
            print(f"   [{i}] {p} ({status})")
        return

    lan_ip = get_lan_ip()

    server = None
    for p in [8899, 18080, 28080, 38080, 8090, 8000]:
        try:
            # 优先采用 IPv6/IPv4 双栈绑定 '::' (同时兼容 localhost, 127.0.0.1, 局域网 IP)
            server = DualStackServer(('::', p), VideoStreamingHTTPRequestHandler)
            server.daemon_threads = True
            break
        except Exception:
            try:
                # 兼容降级至 IPv4 单栈绑定 '0.0.0.0'
                server = ThreadingHTTPServer(('0.0.0.0', p), VideoStreamingHTTPRequestHandler)
                server.daemon_threads = True
                break
            except Exception:
                continue

    if not server:
        try:
            server = DualStackServer(('::', 0), VideoStreamingHTTPRequestHandler)
            server.daemon_threads = True
        except Exception:
            server = ThreadingHTTPServer(('0.0.0.0', 0), VideoStreamingHTTPRequestHandler)
            server.daemon_threads = True

    actual_port = server.server_port

    # 扫描已下载博主
    scanned_tasks, _ = scan_downloaded_media()

    # 立即打印就绪看板 (零延迟，无需等待网络隧道)
    print_banner(lan_ip, actual_port, global_tunnel_url, scanned_tasks)

    # 自动在默认浏览器中打开 WEB 控制总台
    if not args.no_browser:
        import webbrowser
        def auto_open_browser():
            time.sleep(0.5)
            target_url = f"http://127.0.0.1:{actual_port}/dashboard.html"
            print(f">> 🌐 正在自动为您在默认浏览器中打开 WEB 控制总台: {target_url}\n")
            try:
                webbrowser.open(target_url, new=1)
            except Exception as e:
                print(f">> 自动打开浏览器提示: {e}")

        threading.Thread(target=auto_open_browser, daemon=True).start()

    # 异步在后台启动 Cloudflare 隧道 (方案三，在后台启动避免阻塞本地 Web 控制总台毫秒级启动与网页打开)
    def bg_start_tunnel():
        print(">> 正在建立 Cloudflare 全球快速安全公网隧道 (方案三，后台连接中)...")
        t_url = start_cloudflare_tunnel(actual_port)
        if t_url:
            print("\n" + "=" * 60)
            print("  🌐 [✓] Cloudflare 全球公网 HTTPS 隧道已成功连接！")
            print(f"  📱 手机公网抖音刷片: \033[92m{t_url}mobile.html\033[0m")
            print(f"  💻 公网管理看板: {t_url}dashboard.html")
            print("=" * 60 + "\n")

    threading.Thread(target=bg_start_tunnel, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n>> 正在安全关闭服务与穿透隧道...")
        if global_tunnel_proc:
            try:
                global_tunnel_proc.terminate()
            except Exception:
                pass
        print(">> 远程观看服务已完全退出。")

if __name__ == '__main__':
    main()
