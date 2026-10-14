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
import threading
import subprocess
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler

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

def scan_downloaded_media():
    """
    自动扫描 Windows 下载目录，智能识别已下载的 X/Twitter 博主文件夹与媒体
    直接映射为可在手机端立即播放与浏览的任务库，免去用户手动同步操作
    """
    tasks = []
    items_map = {}
    media_exts = {'.mp4', '.jpg', '.jpeg', '.png', '.gif', '.webp'}

    if not os.path.exists(DL_DIR):
        return tasks, items_map

    try:
        for root, dirs, files in os.walk(DL_DIR):
            rel = os.path.relpath(root, DL_DIR)
            depth = len(rel.split(os.sep))
            if depth > 2:
                continue

            media_files = [f for f in files if os.path.splitext(f.lower())[1] in media_exts]
            if not media_files:
                continue

            folder_name = os.path.basename(root)
            # 识别是否为 X 媒体目录
            is_x_media = ('x-media' in rel.lower() or 
                          folder_name.lower().endswith(('_media', '_x_media')) or 
                          any(re.search(r'_\d{15,22}_', f) for f in media_files))
            if not is_x_media:
                continue

            blogger = re.sub(r'(_media|_x_media|_selected)$', '', folder_name, flags=re.I)
            if blogger.lower() == 'unknown' and 'x-media' in rel.lower():
                blogger = 'X_Media_Captured'

            task_id = 'local_' + blogger + '_' + str(abs(hash(rel)) % 100000)
            items = []

            for idx, f in enumerate(sorted(media_files, reverse=True)):
                ext = os.path.splitext(f.lower())[1]
                m_type = 'video' if ext == '.mp4' else 'image'
                tm = re.search(r'_(\d{15,22})_', f)
                tweet_id = tm.group(1) if tm else ''

                file_rel = os.path.join(rel, f).replace('\\', '/')
                if file_rel.startswith('./'):
                    file_rel = file_rel[2:]

                # 媒体文件大小
                full_path = os.path.join(root, f)
                size_mb = round(os.path.getsize(full_path) / (1024 * 1024), 1) if os.path.exists(full_path) else 0

                items.append({
                    'id': f'{task_id}_{idx}',
                    'mediaType': m_type,
                    'tweetId': tweet_id,
                    'tweetText': f'已下载媒体: {f} ({size_mb} MB)',
                    'mediaUrl': '/media_stream/' + urllib.parse.quote(file_rel),
                    'thumbUrl': ('/media_stream/' + urllib.parse.quote(file_rel)) if m_type == 'image' else '',
                    'download_status': 'completed'
                })

            tasks.append({
                'id': task_id,
                'task_name': f'@{blogger} 的媒体库 (本地已下载)',
                'x_name': blogger,
                'x_screen_name': blogger,
                'x_avatar': 'https://abs.twimg.com/favicons/twitter.3.ico',
                'status': 'completed',
                'media_count': len(items),
                'completed_count': len(items),
                'created_at': int(os.path.getmtime(root) * 1000)
            })
            items_map[task_id] = items
    except Exception as e:
        print(f">> 扫描已下载媒体失败: {e}")

    return tasks, items_map

def load_merged_db():
    """读取同步数据库并合并自动扫描到的本地博主媒体库"""
    stored_db = {'tasks': [], 'items': {}}
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, 'r', encoding='utf-8') as f:
                stored_db = json.load(f)
        except Exception:
            pass

    scanned_tasks, scanned_items = scan_downloaded_media()

    # 将自动扫描到的任务与存储的任务合并 (优先展示自动扫描的本地真实任务)
    all_tasks = []
    seen_ids = set()

    for t in scanned_tasks:
        if t['id'] not in seen_ids:
            all_tasks.append(t)
            seen_ids.add(t['id'])

    for t in stored_db.get('tasks', []):
        if t['id'] not in seen_ids:
            all_tasks.append(t)
            seen_ids.add(t['id'])

    merged_items = dict(scanned_items)
    merged_items.update(stored_db.get('items', {}))

    return {'tasks': all_tasks, 'items': merged_items}

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

        # 根路径自动重定向至控制台
        if path in ('', '/', '/index.html'):
            self.send_response(302)
            self.send_header('Location', '/dashboard.html')
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

        self.send_error(404, "Unknown API")

    def send_head(self):
        # 处理本地媒体流映射: /media_stream/<rel_path>
        if self.path.startswith('/media_stream/'):
            clean_rel = urllib.parse.unquote(self.path[len('/media_stream/'):])
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
    local_url = f"http://{lan_ip}:{port}/"
    qr_target = tunnel_url if tunnel_url else local_url

    print("\n" + "=" * 68)
    print("  🚀 X-Media-Downloader 安卓远程流媒体与公网穿透服务已就绪！")
    print("=" * 68)

    if tunnel_url:
        print("\n  🌐 [方案三：全球公网 HTTPS 直达 (免 Wi-Fi 限制 / 4G/5G 均可随时看)]：")
        print(f"  🔗 公网地址 : \033[92m{tunnel_url}\033[0m")
    
    print("\n  📶 [方案一：家庭 Wi-Fi 局域网直连]：")
    print(f"  🔗 局域网地址 : {local_url}")

    # 尝试打印 ASCII 二维码
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(qr_target)
        qr.make(fit=True)
        print("\n  📱 [手机微信 / 相机扫码直达]：")
        qr.print_ascii(invert=True)
    except Exception:
        pass

    print("\n  📁 [已自动扫描并挂载本地下载库]：")
    if scanned_tasks:
        for t in scanned_tasks:
            print(f"     ✅ {t['task_name']} (含 {t['media_count']} 个媒体文件)")
    else:
        print("     ℹ️ 暂未扫描到 X 媒体文件夹，若在控制台新建下载将自动出现在手机端。")

    print("\n  💡 使用小贴士：")
    print("  1. 手机在任意网络（4G/5G或Wi-Fi）下直接访问【公网地址】或【扫描二维码】；")
    print("  2. 点击博主即可全屏预览所有图片，并流畅播放高码率 MP4（支持进度条拖拽快进）；")
    print("  3. 彻底免去把视频拷贝到手机的繁琐步骤，零占用手机内存！")
    print("\n  （按 Ctrl + C 可随时安全停止服务）")
    print("=" * 68 + "\n")

def main():
    os.chdir(_curr_dir)
    lan_ip = get_lan_ip()

    server = None
    for p in [8899, 18080, 28080, 38080, 8090, 8000]:
        try:
            server = HTTPServer(('0.0.0.0', p), VideoStreamingHTTPRequestHandler)
            break
        except Exception:
            continue

    if not server:
        server = HTTPServer(('0.0.0.0', 0), VideoStreamingHTTPRequestHandler)

    actual_port = server.server_port

    # 启动 Cloudflare 隧道 (方案三)
    print(">> 正在建立 Cloudflare 全球快速安全公网隧道 (方案三)...")
    tunnel_url = start_cloudflare_tunnel(actual_port)

    # 扫描已下载博主
    scanned_tasks, _ = scan_downloaded_media()

    print_banner(lan_ip, actual_port, tunnel_url, scanned_tasks)

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
