#!/usr/bin/env python3
"""喵喵存金罐桌面应用入口。

调用关系：
1. main() 根据运行形态决定资源目录与数据目录。
2. 创建 Api 实例，把 Python 端能力通过 pywebview 暴露给前端 JS。
3. 加载 web/index.html，后续页面交互由 web/app.js -> pywebview.api -> Api -> BookkeepingService 完成。

排查建议：
- 前端页面打不开，先看 get_base_path() 是否找到打包后的 web 目录。
- 数据没有落盘，先看 get_data_dir() 是否指向预期目录。
- 前后端桥接异常，再继续看 api.py。
"""
import argparse
import sys
from pathlib import Path

import webview

from api import Api


# PyInstaller 打包后会注入 frozen/_MEIPASS；源码运行时这两个标记不存在。
def is_bundled():
    return getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS")


# 前端静态资源目录选择：打包态取解包目录，源码态取仓库根目录下的 web/。
def get_base_path():
    if is_bundled():
        return Path(sys._MEIPASS)
    return Path(__file__).parent


# 数据目录选择：
# - 打包态：写到用户家目录下的 .meow_money，避免写入应用安装目录失败。
# - 源码态：直接复用当前项目目录，方便本地开发和查看 JSON 数据文件。
def get_data_dir():
    if is_bundled():
        home = Path.home()
        data_dir = home / ".meow_money"
        data_dir.mkdir(exist_ok=True)
        return data_dir
    else:
        return Path(__file__).parent


# 桌面窗口启动入口：负责把前端页面和 Python API 绑定到同一个 pywebview 窗口中。
def parse_args():
    parser = argparse.ArgumentParser(description="喵喵存金罐")
    parser.add_argument(
        "-d", "--debug", action="store_true", help="启用调试模式（允许打开开发者工具）"
    )
    parser.add_argument(
        "-w", "--watch-web",
        action="store_true",
        help="开发模式：监听 web 目录变化并自动刷新前端页面",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    debug_mode = args.debug
    data_dir = get_data_dir()

    # 前端 SPA 页面入口，页面内的按钮与表单最终都会落到 app.js 中的事件处理逻辑。
    web_dir = get_base_path() / "web"
    api = Api(
        data_dir,
        debug_mode=debug_mode,
        web_dir=web_dir,
        watch_web=args.watch_web,
    )
    window = webview.create_window(
        title="喵喵存金罐",
        url=str(web_dir / "index.html"),
        js_api=api,
        width=1100,
        height=750,
        min_size=(900, 650),
    )
    api.set_window(window)
    webview.start(debug=debug_mode)
    sys.exit()


if __name__ == "__main__":
    main()
