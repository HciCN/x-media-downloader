# X-Media-Downloader (X/Twitter 批量媒体抓取与下载工具)

基于对 **Plucker XBD** 逆向工程深度重构的独立无广告版本，无需依赖外部付费第三方云端，所有抓取与下载均在本地浏览器中直接完成。

---

## 🚀 核心功能与亮点

1. **自动游标分页（Cursor Pagination）**：
   - 自动拦截 X/Twitter 官方 GraphQL 接口（`UserMedia` / `UserTweets`），深度提取 `TimelineTimelineCursor (Bottom)`，自动向下迭代抓取，无漏网推文。
2. **最高画质无损媒体提取**：
   - **图片**：自动替换为最高清无损原图直链（`?name=orig`）。
   - **视频 / GIF**：自动解析推文媒体 variants，按码率（`bitrate`）降序筛选最高画质 MP4。
3. **Plucker 同款动态防封退避算法**：
   - 内置根据翻页深度的自适应阶梯随机等待机制（`By(p)`），抓得越多等待间隔越平滑，彻底避免触发 Twitter 429 速率限制或账号风险。
4. **多重下载与导出方案**：
   - **一键打包 ZIP**：内置离线 JSZip，自动以 `博主_推文ID_序号.jpg/mp4` 组织并打包下载，单次完成数百张图无需点击多次。
   - **原生多线程并发下载**（Chrome 扩展专属）：调用 Chrome 后台下载管理器，支持 1~10 线程并发后台高速保存。
   - **TXT 直链导出 / 一键复制**：支持导出 URL 清单，可无缝导入迅雷、IDM、Motrix、Aria2 或 wget。
   - **JSON 完整元数据导出**：导出推文正文、发推时间、原推 ID 及多媒体对应关系。
5. **实时媒体缩略图画廊**：
   - 控制面板内置预览抽屉，抓取过程中实时渲染缩略图，点击可直接打开全尺寸高清原图/原视频播放。

---

## 🛠️ 安装与使用教程（提供两种方式，任选其一即可）

### 方式一：Chrome / Edge 原生扩展安装（推荐，功能最全）

1. 打开 Chrome 或 Edge 浏览器，在地址栏输入并回车：
   - Chrome：`chrome://extensions/`
   - Edge：`edge://extensions/`
2. 打开页面右上角的 **「开发者模式」** 开关。
3. 点击左上角的 **「加载已解压的扩展程序」**（Load unpacked）。
4. 在文件选择窗口中，选择本目录：
   ```
   F:\桌面文件\AI脚本\x-media-downloader
   ```
5. 安装成功后，打开任何 Twitter/X 博主主页（例如：`https://x.com/username` 或 `https://x.com/username/media`）：
   - 页面右下角将出现蓝色下载圆形悬浮按钮。
   - 点击即可展开控制面板，点击 **「开始批量抓取」**！

---

### 方式二：油猴脚本安装（无需安装扩展，单文件即用）

如果你已经安装了 **Tampermonkey（篡改猴）** 或 **Violentmonkey（暴力猴）** / **ScriptCat（脚本猫）**：

1. 打开位于根目录的脚本文件：
   ```
   F:\桌面文件\AI脚本\X批量媒体下载器.user.js
   ```
2. 打开 Tampermonkey 仪表盘 -> **「实用工具」** -> **「导入」** 选择该文件，或者新建脚本将文件内容全选复制粘贴进去保存。
3. 刷新任何 X/Twitter 个人主页即可在右下角看到操作面板！

---

## 📁 目录结构

```
f:\桌面文件\AI脚本\x-media-downloader\
├── manifest.json              # Chrome 扩展配置清单 (MV3)
├── background.js             # 原生下载管理后台服务
├── content.js                # 前端注入与控制面板逻辑
├── injected.js               # 页面主世界 Hook 与 GraphQL 嗅探引擎
├── ui.css                    # 仿 X 官方现代黑金色调 UI
├── libs/
│   └── jszip.min.js          # 离线打包核心库 (无需联网即可压缩)
├── icons/                    # 高清扩展图标 (16x16, 48x48, 128x128)
├── x-media-downloader.user.js # 独立油猴脚本单文件
└── README.md                 # 详细说明文档
```
