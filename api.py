"""PyWebView 前后端桥接层。

这个文件不直接做复杂记账计算，核心职责是：
1. 把 web/app.js 里的 pywebview.api.xxx 调用暴露给前端。
2. 把参数转发给 BookkeepingService。
3. 在少数场景补充桥接层逻辑，例如：
   - 统计页默认时间范围的推导
   - 主题配置读写
   - 数据备份导入导出与回滚

建议的排障阅读顺序：
- 前端按钮点击后没有反应：先确认 app.js 是否调用了正确的 pywebview.api 方法名。
- 返回了 success=false：优先看 api_error_handler 包装后的错误类型和 message。
- 桥接层本身没有额外逻辑时，再继续看 services/bookkeeping.py 中对应方法。
"""
import json
import traceback
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any

from services.bookkeeping import BookkeepingService


# 统一把 Python 异常转成前端更容易消费的结构化结果，
# 避免 pywebview 直接把异常抛回 JS 侧后难以区分是校验问题、文件问题还是未知错误。
def api_error_handler(func):
    """API 错误处理装饰器。"""
    def wrapper(*args, **kwargs):
        # 这里不吞掉业务结果，只在抛异常时转换为 {success, error, error_type}。
        try:
            return func(*args, **kwargs)
        except ValueError as e:
            return {"success": False, "error": str(e), "error_type": "validation"}
        except FileNotFoundError as e:
            return {"success": False, "error": f"文件未找到: {e}", "error_type": "file"}
        except PermissionError as e:
            return {"success": False, "error": f"权限不足: {e}", "error_type": "permission"}
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "error_type": "unknown",
                "traceback": traceback.format_exc()
            }
    return wrapper


class Api:
    """pywebview 暴露给前端的 API 集合。

    上游：
    - main.py 在创建窗口时把 Api 实例挂到 js_api。
    - web/app.js 通过 pywebview.api.<method>() 调用这里的方法。

    下游：
    - 大多数方法继续委托给 BookkeepingService。
    - 少量方法负责主题配置、时间区间推导、备份导入导出。
    """

    def __init__(self, data_dir: Path):
        # data_dir 是应用运行目录或打包后的用户数据目录；实际账本数据都在其下的“记账数据/”。
        self.data_dir = data_dir
        self.bookkeeping = BookkeepingService(data_dir / "记账数据")

    def __dir__(self):
        # pywebview 会根据对象可见方法名生成 JS 可调用接口，这里显式限制为类上可调用成员。
        return [name for name, val in self.__class__.__dict__.items() if callable(val)]

    # ========== 分类管理（含多级） ==========
    # 对应前端：分类管理页、记一笔页面的分类选择器。
    def get_categories(self, type_filter: str = "", include_children: bool = True):
        return self.bookkeeping.get_categories(type_filter, include_children)

    def get_flat_categories(self, type_filter: str = ""):
        return self.bookkeeping.get_flat_categories(type_filter)

    @api_error_handler
    def add_category(self, name: str, icon: str, color: str, cat_type: str, parent_id: str = ""):
        return self.bookkeeping.add_category(name, icon, color, cat_type, parent_id)

    @api_error_handler
    def update_category(self, id: str, name: str, icon: str, color: str):
        return self.bookkeeping.update_category(id, name, icon, color)

    @api_error_handler
    def delete_category(self, id: str, strategy: str = "check", migrate_to: str = ""):
        return self.bookkeeping.delete_category(id, strategy, migrate_to)

    # ========== 标签管理 ==========
    # 当前前端主要把标签作为记录辅助信息，接口较薄，基本只做转发。
    def get_tags(self, category_id: str = ""):
        return self.bookkeeping.get_tags(category_id)

    @api_error_handler
    def add_tag(self, name: str, category_id: str = ""):
        return self.bookkeeping.add_tag(name, category_id)

    @api_error_handler
    def delete_tag(self, id: str):
        return self.bookkeeping.delete_tag(id)

    # ========== 账户管理 ==========
    # 对应前端：账户管理页、记一笔页账户下拉、转账/对账弹窗。
    def get_accounts(self):
        return self.bookkeeping.get_accounts()

    @api_error_handler
    def add_account(self, name: str, acc_type: str, icon: str, color: str, balance: float = 0.0, credit_limit: float = 0.0, billing_day: int = 0, repayment_day: int = 0, note: str = ""):
        return self.bookkeeping.add_account(name, acc_type, icon, color, balance, credit_limit, billing_day, repayment_day, note)

    @api_error_handler
    def update_account(self, id: str, name: str, icon: str, color: str, balance: float = None, credit_limit: float = None, billing_day: int = None, repayment_day: int = None, note: str = None):
        return self.bookkeeping.update_account(id, name, icon, color, balance, credit_limit, billing_day, repayment_day, note)

    @api_error_handler
    def delete_account(self, id: str, strategy: str = "check", migrate_to: str = ""):
        return self.bookkeeping.delete_account(id, strategy, migrate_to)

    def get_total_assets(self):
        return self.bookkeeping.get_total_assets()

    @api_error_handler
    def transfer(self, from_account_id: str, to_account_id: str, amount: float, date: str = "", note: str = ""):
        return self.bookkeeping.transfer(from_account_id, to_account_id, amount, date, note)

    @api_error_handler
    def adjust_balance(self, account_id: str, new_balance: float, note: str = ""):
        return self.bookkeeping.adjust_balance(account_id, new_balance, note)

    # ========== 预算管理 ==========
    # 对应前端：预算列表、预算设置弹窗、保存记录后的预算提醒弹窗。
    def get_budgets(self, ledger_id: str = ""):
        return self.bookkeeping.get_budgets(ledger_id)

    @api_error_handler
    def add_budget(self, name: str, budget_type: str, amount: float, category_id: str = "", period: str = "month", ledger_id: str = ""):
        return self.bookkeeping.add_budget(name, budget_type, amount, category_id, period, ledger_id)

    @api_error_handler
    def update_budget(self, id: str, name: str, amount: float):
        return self.bookkeeping.update_budget(id, name, amount)

    @api_error_handler
    def delete_budget(self, id: str):
        return self.bookkeeping.delete_budget(id)

    def get_budget_status(self, ledger_id: str = ""):
        return self.bookkeeping.get_budget_status(ledger_id)

    # ========== 账本管理 ==========
    # 对应前端：侧边栏账本切换器、账本管理页。
    def get_ledgers(self, include_archived: bool = False):
        return self.bookkeeping.get_ledgers(include_archived)

    @api_error_handler
    def add_ledger(self, name: str, icon: str, color: str):
        return self.bookkeeping.add_ledger(name, icon, color)

    @api_error_handler
    def update_ledger(self, id: str, name: str, icon: str, color: str):
        return self.bookkeeping.update_ledger(id, name, icon, color)

    @api_error_handler
    def archive_ledger(self, id: str):
        return self.bookkeeping.archive_ledger(id)

    @api_error_handler
    def delete_ledger(self, id: str):
        return self.bookkeeping.delete_ledger(id)

    # ========== 记录管理 ==========
    # 对应前端：记一笔页、账单明细页、编辑记录弹窗。
    def get_records(self, start_date: str = "", end_date: str = "", type_filter: str = "", category_id: str = "", account_id: str = "", ledger_id: str = "", limit: int = 0):
        return self.bookkeeping.get_records(start_date, end_date, type_filter, category_id, account_id, ledger_id, limit)

    @api_error_handler
    def add_record(self, rec_type: str, amount: float, category_id: str, date: str, time: str = "", note: str = "", tags: List[str] = None, account_id: str = "", ledger_id: str = ""):
        return self.bookkeeping.add_record(rec_type, amount, category_id, date, time, note, tags, account_id, ledger_id)

    @api_error_handler
    def update_record(self, id: str, rec_type: str, amount: float, category_id: str, date: str, time: str = "", note: str = "", tags: List[str] = None, account_id: str = "", ledger_id: str = ""):
        return self.bookkeeping.update_record(id, rec_type, amount, category_id, date, time, note, tags, account_id, ledger_id)

    @api_error_handler
    def delete_record(self, id: str):
        return self.bookkeeping.delete_record(id)

    # ========== 智能推荐 ==========
    # 供“记一笔”页面顶部的推荐卡片使用。
    def get_smart_suggestions(self):
        return self.bookkeeping.get_smart_suggestions()

    # ========== 统计功能 ==========
    # 这里主要负责把“今天/本周/本月/本年”这类 UI 概念换算成 service 需要的明确日期区间。
    def get_today_summary(self, ledger_id: str = ""):
        # 首页/统计页的“今日汇总”直接复用通用 summary 能力，只是在桥接层补日期范围。
        today = datetime.now().strftime("%Y-%m-%d")
        return self.bookkeeping.get_summary(today, today, ledger_id)

    def get_week_summary(self, ledger_id: str = ""):
        today = datetime.now()
        monday = today - timedelta(days=today.weekday())
        sunday = monday + timedelta(days=6)
        return self.bookkeeping.get_summary(monday.strftime("%Y-%m-%d"), sunday.strftime("%Y-%m-%d"), ledger_id)

    def get_month_summary(self, ledger_id: str = ""):
        today = datetime.now()
        start = today.replace(day=1).strftime("%Y-%m-%d")
        if today.month == 12:
            end = today.replace(year=today.year + 1, month=1, day=1) - timedelta(days=1)
        else:
            end = today.replace(month=today.month + 1, day=1) - timedelta(days=1)
        return self.bookkeeping.get_summary(start, end.strftime("%Y-%m-%d"), ledger_id)

    def get_year_summary(self, ledger_id: str = ""):
        year = datetime.now().year
        return self.bookkeeping.get_summary(f"{year}-01-01", f"{year}-12-31", ledger_id)

    def get_summary(self, start_date: str, end_date: str, ledger_id: str = ""):
        return self.bookkeeping.get_summary(start_date, end_date, ledger_id)

    def get_daily_stats(self, start_date: str, end_date: str, ledger_id: str = ""):
        return self.bookkeeping.get_daily_stats(start_date, end_date, ledger_id)

    def get_weekly_stats(self, date: str = "", ledger_id: str = ""):
        return self.bookkeeping.get_weekly_stats(date, ledger_id)

    def get_monthly_stats(self, year: int = 0, ledger_id: str = ""):
        if not year:
            year = datetime.now().year
        return self.bookkeeping.get_monthly_stats(year, ledger_id)

    def get_category_stats(self, start_date: str, end_date: str, rec_type: str = "expense", ledger_id: str = ""):
        return self.bookkeeping.get_category_stats(start_date, end_date, rec_type, ledger_id)

    def get_asset_trend(self, months: int = 6):
        return self.bookkeeping.get_asset_trend(months)

    # ========== 数据导出 ==========
    # 供侧边栏导出弹窗调用，返回的是 CSV 字符串，由前端决定如何下载。
    def export_records_csv(self, start_date: str = "", end_date: str = "", ledger_id: str = ""):
        return self.bookkeeping.export_records_csv(start_date, end_date, ledger_id)

    def export_summary_csv(self, year: int = 0, ledger_id: str = ""):
        if not year:
            year = datetime.now().year
        return self.bookkeeping.export_summary_csv(year, ledger_id)

    # ========== 系统配置 ==========
    # 当前只有主题配置落在 config.json；其余业务数据都由 BookkeepingService 管理到“记账数据/”下。
    def get_theme(self):
        """读取保存的主题设置。

        前端初始化时会先调这个方法，再回退到 localStorage。
        """
        config_path = self.data_dir / "config.json"
        if config_path.exists():
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
                    return config.get("theme", "cute")
            except Exception:
                pass
        return "cute"

    def save_theme(self, theme: str):
        """保存主题设置。

        这里单独落到 config.json，而不是记账数据 JSON 集合中，方便与业务数据解耦。
        """
        config_path = self.data_dir / "config.json"
        config = {}
        if config_path.exists():
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
            except Exception:
                pass
        config["theme"] = theme
        try:
            with open(config_path, "w", encoding="utf-8") as f:
                json.dump(config, f, ensure_ascii=False, indent=2)
            return True
        except Exception:
            return False

    # ========== 数据备份与恢复 ==========
    # 对应前端：数据备份页。导出返回完整 JSON；导入会先校验结构，再尝试覆盖写入，并在失败时回滚。
    def export_data(self):
        """导出完整备份 JSON。

        这里按“前端可恢复”的口径导出所有核心业务实体与主题设置。
        """
        data = {
            "version": "1.0",
            "exported_at": datetime.now().isoformat(),
            "app": "喵喵存金罐",
            "data": {
                "categories": self.bookkeeping.get_categories(),
                "tags": self.bookkeeping.get_tags(),
                "accounts": self.bookkeeping.get_accounts(),
                "budgets": self.bookkeeping.get_budgets(),
                "ledgers": self.bookkeeping.get_ledgers(include_archived=True),
                "records": self.bookkeeping.get_records(),
                "theme": self.get_theme()
            }
        }
        return data

    @api_error_handler
    def import_data(self, json_data: dict):
        """从 JSON 数据导入（覆盖现有数据），带数据验证和回滚机制。"""
        if not isinstance(json_data, dict) or "data" not in json_data:
            return {"success": False, "error": "无效的备份数据格式"}

        data = json_data["data"]
        data_dir = self.bookkeeping.data_dir

        # 只校验最小必需字段，确保恢复后的数据至少能被 service 层重新加载。
        required_fields = {
            "categories": ["id", "name", "type"],
            "tags": ["id", "name"],
            "accounts": ["id", "name", "type"],
            "budgets": ["id", "name", "amount"],
            "ledgers": ["id", "name"],
            "records": ["id", "type", "amount", "category_id"],
        }

        # 逐类校验结构，尽量在真正覆盖磁盘文件前把格式问题拦住。
        for key, fields in required_fields.items():
            if key in data and isinstance(data[key], list):
                for i, item in enumerate(data[key]):
                    if not isinstance(item, dict):
                        return {"success": False, "error": f"{key}[{i}] 不是有效的对象"}
                    missing = [f for f in fields if f not in item]
                    if missing:
                        return {"success": False, "error": f"{key}[{i}] 缺少必要字段: {', '.join(missing)}"}

        # 覆盖写入前先把当前 JSON 文本整体备份下来；任一环节出错时可直接原样恢复。
        backup_files = {}
        file_names = ["categories.json", "tags.json", "accounts.json", "budgets.json", "ledgers.json", "records.json"]
        for fname in file_names:
            fpath = data_dir / fname
            if fpath.exists():
                backup_files[fname] = fpath.read_text(encoding="utf-8")

        imported = {"categories": 0, "tags": 0, "accounts": 0, "budgets": 0, "ledgers": 0, "records": 0}

        try:
            # 注意：这里直接写 JSON 文件，不走 service 的增删改接口，因此成功后前端通常需要重新加载页面状态。

            # 导入分类
            if "categories" in data and isinstance(data["categories"], list):
                (data_dir / "categories.json").write_text(
                    json.dumps(data["categories"], ensure_ascii=False, indent=2), encoding="utf-8")
                imported["categories"] = len(data["categories"])

            # 导入标签
            if "tags" in data and isinstance(data["tags"], list):
                (data_dir / "tags.json").write_text(
                    json.dumps(data["tags"], ensure_ascii=False, indent=2), encoding="utf-8")
                imported["tags"] = len(data["tags"])

            # 导入账户
            if "accounts" in data and isinstance(data["accounts"], list):
                (data_dir / "accounts.json").write_text(
                    json.dumps(data["accounts"], ensure_ascii=False, indent=2), encoding="utf-8")
                imported["accounts"] = len(data["accounts"])

            # 导入预算
            if "budgets" in data and isinstance(data["budgets"], list):
                (data_dir / "budgets.json").write_text(
                    json.dumps(data["budgets"], ensure_ascii=False, indent=2), encoding="utf-8")
                imported["budgets"] = len(data["budgets"])

            # 导入账本
            if "ledgers" in data and isinstance(data["ledgers"], list):
                (data_dir / "ledgers.json").write_text(
                    json.dumps(data["ledgers"], ensure_ascii=False, indent=2), encoding="utf-8")
                imported["ledgers"] = len(data["ledgers"])

            # 导入记录
            if "records" in data and isinstance(data["records"], list):
                (data_dir / "records.json").write_text(
                    json.dumps(data["records"], ensure_ascii=False, indent=2), encoding="utf-8")
                imported["records"] = len(data["records"])

            # 导入主题
            if "theme" in data:
                self.save_theme(data["theme"])

            return {"success": True, "imported": imported}

        except Exception as e:
            # 任意文件写入失败时都尽量回滚到导入前状态，避免出现“半导入”数据集。
            for fname, content in backup_files.items():
                try:
                    (data_dir / fname).write_text(content, encoding="utf-8")
                except Exception:
                    pass
            return {"success": False, "error": f"导入失败，已回滚: {str(e)}"}

    def get_data_stats(self):
        """获取数据统计信息。

        对应前端备份页顶部统计卡片，用于展示当前数据量概览。
        """
        return {
            "categories": len(self.bookkeeping.get_categories()),
            "tags": len(self.bookkeeping.get_tags()),
            "accounts": len(self.bookkeeping.get_accounts()),
            "budgets": len(self.bookkeeping.get_budgets()),
            "ledgers": len(self.bookkeeping.get_ledgers(include_archived=True)),
            "records": len(self.bookkeeping.get_records())
        }
