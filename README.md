# 喵喵存金罐 🐱💰

一款可爱的个人记账桌面应用，帮助你轻松管理日常收支。

![Python](https://img.shields.io/badge/Python-3.10+-blue.svg)
![License](https://img.shields.io/badge/License-MIT-green.svg)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-lightgrey.svg)

## ✨ 功能特性

- 📝 **收支记录** - 快速记录日常收入和支出
- 📊 **统计分析** - 多维度图表展示消费趋势
- 💳 **多账户管理** - 支持现金、银行卡、信用卡等多种账户
- 🔄 **账户转账** - 账户间资金转移，自动更新余额
- 🎯 **预算管理** - 设置月度预算，超支提醒
- 📚 **多账本** - 支持多个独立账本（如日常、旅行、项目等）
- 🏷️ **分类管理** - 自定义收支分类，支持子分类
- 💾 **数据备份** - 一键导出/导入数据，安全可靠
- 🎨 **多主题** - 10+ 精美主题，亮色/暗色随心切换
- 🐱 **猫咪互动** - 可爱的猫咪眼睛会跟随鼠标移动

## 📸 截图

<!-- 可以添加应用截图 -->

## 🚀 快速开始

### 方式一：下载预编译版本

前往 [Releases](https://github.com/xrjjing/meow-piggy-bank/releases) 下载对应平台的安装包。

### 方式二：从源码运行

```bash
# 克隆项目
git clone https://github.com/xrjjing/meow-piggy-bank.git
cd meow-piggy-bank

# 创建虚拟环境
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt

# 运行应用
python main.py
```

## 📦 打包

```bash
# 安装打包工具
pip install pyinstaller

# 运行打包脚本
python build.py

# 或手动打包
# macOS
pyinstaller --onedir --windowed --name "喵喵存金罐" --add-data "web:web" --add-data "services:services" main.py

# Windows
pyinstaller --onedir --windowed --name "喵喵存金罐" --add-data "web;web" --add-data "services;services" main.py
```

打包完成后，可执行文件位于 `dist/喵喵存金罐/` 目录。

## 🗂️ 项目结构

```
meow-piggy-bank/
├── main.py              # 应用入口
├── api.py               # PyWebView API 接口
├── build.py             # 打包脚本
├── services/            # 业务逻辑层
│   └── bookkeeping.py   # 记账核心服务
├── web/                 # 前端资源
│   ├── index.html       # 主页面
│   ├── styles.css       # 样式表
│   └── app.js           # 前端逻辑
├── icons/               # 图标资源
└── tests/               # 单元测试
```

## 🔧 技术栈

- **后端**: Python 3.10+
- **桌面框架**: [pywebview](https://pywebview.flowrl.com/)
- **前端**: 原生 HTML/CSS/JavaScript
- **打包**: PyInstaller

## 📄 数据存储

应用数据存储在本地 `记账数据/` 目录下，包括：
- `records.json` - 收支记录
- `accounts.json` - 账户信息
- `categories.json` - 分类配置
- `budgets.json` - 预算设置
- `ledgers.json` - 账本列表
- `tags.json` - 标签

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📜 许可证

本项目采用 [MIT 许可证](LICENSE)。
