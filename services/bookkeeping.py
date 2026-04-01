"""记账核心服务层。

这个文件是项目里真正的业务中枢，负责：
1. 初始化并维护本地 JSON 数据文件。
2. 提供分类、标签、账户、预算、账本、记录等增删改查。
3. 负责统计、导出、预算提醒、转账、对账等衍生能力。

调用关系：
- 上游主要来自 api.py，再由 web/app.js 通过 pywebview.api 间接触发。
- 下游主要是“记账数据/”目录下的多个 JSON 文件。

建议排障顺序：
- 数据文件异常：先看 _ensure_files / _load_json / _save_json。
- 余额不对：优先看 add_record / update_record / delete_record / transfer / adjust_balance / _update_account_balance。
- 页面统计不对：继续看 get_summary / get_daily_stats / get_category_stats / get_monthly_stats / get_asset_trend。
"""
from __future__ import annotations

import csv
import json
import uuid
from decimal import Decimal, ROUND_HALF_UP
from io import StringIO
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Union
from dataclasses import dataclass, asdict, field
from calendar import monthrange
from collections import defaultdict, Counter


# ========== 常量定义 ==========
# 这里集中放业务约束，便于前后端对齐金额、名称长度、预算阈值、可选类型等基础规则。
MAX_AMOUNT = Decimal("999999999.99")
MIN_AMOUNT = Decimal("0.01")
BUDGET_WARNING_THRESHOLD = 80
ORDER_OTHER_CATEGORY = 99
MAX_NAME_LENGTH = 100
MAX_NOTE_LENGTH = 500
VALID_RECORD_TYPES = {"income", "expense"}
VALID_ACCOUNT_TYPES = {"cash", "bank", "credit", "investment", "loan"}
VALID_BUDGET_TYPES = {"total", "category"}
VALID_BUDGET_PERIODS = {"month", "year"}


# ========== 数据验证工具 ==========
# 这些工具函数是 service 层所有写操作的统一入口，能减少不同方法各自做校验导致的不一致。
def validate_amount(amount: Union[int, float, Decimal], allow_zero: bool = False) -> Decimal:
    """验证并转换金额为Decimal"""
    try:
        amt = Decimal(str(amount))
    except Exception:
        raise ValueError("金额必须是有效数字")
    if amt < 0:
        raise ValueError("金额不能为负数")
    if not allow_zero and amt == 0:
        raise ValueError("金额不能为零")
    if amt > MAX_AMOUNT:
        raise ValueError(f"金额超出限制（最大 {MAX_AMOUNT}）")
    return amt.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def validate_date(date_str: str) -> str:
    """验证日期格式 YYYY-MM-DD"""
    if not date_str:
        raise ValueError("日期不能为空")
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
        return date_str
    except ValueError:
        raise ValueError(f"无效的日期格式: {date_str}，需要 YYYY-MM-DD")


def validate_time(time_str: str) -> str:
    """验证时间格式 HH:MM"""
    if not time_str:
        return ""
    try:
        datetime.strptime(time_str, "%H:%M")
        return time_str
    except ValueError:
        raise ValueError(f"无效的时间格式: {time_str}，需要 HH:MM")


def validate_string(s: str, field_name: str, max_length: int = MAX_NAME_LENGTH, allow_empty: bool = False) -> str:
    """验证字符串"""
    if not isinstance(s, str):
        s = str(s) if s is not None else ""
    s = s.strip()
    if not allow_empty and not s:
        raise ValueError(f"{field_name}不能为空")
    if len(s) > max_length:
        raise ValueError(f"{field_name}长度不能超过{max_length}个字符")
    return s


def generate_unique_id(prefix: str = "") -> str:
    """生成唯一ID（使用UUID避免碰撞）"""
    uid = uuid.uuid4().hex[:16]
    return f"{prefix}_{uid}" if prefix else uid


def safe_divide(numerator: float, denominator: float, default: float = 0.0) -> float:
    """安全除法，避免除零错误"""
    if denominator == 0 or denominator is None:
        return default
    return numerator / denominator


def decimal_to_float(value: Union[Decimal, float, int]) -> float:
    """将Decimal安全转换为float"""
    if isinstance(value, Decimal):
        return float(value)
    return float(value) if value is not None else 0.0


# ========== 数据模型 ==========
# 这些 dataclass 是 JSON 持久化与内存对象之间的中间形态；
# _load_xxx / _save_xxx 会在“字典 <-> dataclass”之间来回转换。
@dataclass
class Category:
    """收支分类"""
    id: str
    name: str
    icon: str
    color: str
    type: str  # "income" | "expense"
    parent_id: str = ""  # 父分类ID，空表示顶级分类
    is_system: bool = True
    order: int = 0


@dataclass
class Tag:
    """场景标签"""
    id: str
    name: str
    category_id: str = ""
    is_system: bool = True


@dataclass
class Account:
    """账户"""
    id: str
    name: str
    type: str  # "cash" | "bank" | "credit" | "investment" | "loan"
    icon: str
    color: str
    balance: float = 0.0
    # 信用卡专用
    credit_limit: float = 0.0
    billing_day: int = 0  # 账单日（1-28）
    repayment_day: int = 0  # 还款日（1-28）
    # 通用
    note: str = ""
    is_default: bool = False
    order: int = 0


@dataclass
class Budget:
    """预算"""
    id: str
    name: str
    type: str  # "total" | "category"
    category_id: str = ""  # 分类预算时使用
    amount: float = 0.0
    period: str = "month"  # "month" | "year"
    ledger_id: str = ""  # 关联账本，空表示默认账本


@dataclass
class Ledger:
    """账本"""
    id: str
    name: str
    icon: str
    color: str
    is_default: bool = False
    is_archived: bool = False
    created_at: str = ""


@dataclass
class Record:
    """收支记录"""
    id: str
    type: str  # "income" | "expense"
    amount: float
    category_id: str
    account_id: str = ""  # 关联账户
    ledger_id: str = ""  # 关联账本，空表示默认账本
    date: str = ""  # YYYY-MM-DD
    time: str = ""  # HH:MM
    note: str = ""
    tags: List[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""


# ========== 默认种子数据 ==========
# 首次启动时如果对应 JSON 不存在，会写入这一批默认数据，保证应用有可用的初始分类/账户/账本。
# 预设支出分类（含子分类）
DEFAULT_EXPENSE_CATEGORIES = [
    Category("exp_food", "餐饮", "🍜", "#FFB7B2", "expense", "", True, 0),
    Category("exp_food_breakfast", "早餐", "🥐", "#FFB7B2", "expense", "exp_food", True, 0),
    Category("exp_food_lunch", "午餐", "🍱", "#FFB7B2", "expense", "exp_food", True, 1),
    Category("exp_food_dinner", "晚餐", "🍲", "#FFB7B2", "expense", "exp_food", True, 2),
    Category("exp_food_snack", "小吃", "🍿", "#FFB7B2", "expense", "exp_food", True, 3),
    Category("exp_transport", "交通", "🚌", "#B5EAD7", "expense", "", True, 1),
    Category("exp_transport_subway", "地铁", "🚇", "#B5EAD7", "expense", "exp_transport", True, 0),
    Category("exp_transport_bus", "公交", "🚌", "#B5EAD7", "expense", "exp_transport", True, 1),
    Category("exp_transport_taxi", "打车", "🚕", "#B5EAD7", "expense", "exp_transport", True, 2),
    Category("exp_transport_fuel", "加油", "⛽", "#B5EAD7", "expense", "exp_transport", True, 3),
    Category("exp_shopping", "购物", "🛍️", "#C7CEEA", "expense", "", True, 2),
    Category("exp_shopping_clothes", "服饰", "👔", "#C7CEEA", "expense", "exp_shopping", True, 0),
    Category("exp_shopping_digital", "数码", "📱", "#C7CEEA", "expense", "exp_shopping", True, 1),
    Category("exp_shopping_daily", "日用", "🧴", "#C7CEEA", "expense", "exp_shopping", True, 2),
    Category("exp_entertainment", "娱乐", "🎮", "#FFDAC1", "expense", "", True, 3),
    Category("exp_housing", "居家", "🏠", "#E0BBE4", "expense", "", True, 4),
    Category("exp_housing_rent", "房租", "🏘️", "#E0BBE4", "expense", "exp_housing", True, 0),
    Category("exp_housing_utility", "水电", "💡", "#E0BBE4", "expense", "exp_housing", True, 1),
    Category("exp_medical", "医疗", "💊", "#FF9AA2", "expense", "", True, 5),
    Category("exp_education", "教育", "📚", "#A8D8EA", "expense", "", True, 6),
    Category("exp_social", "人情", "🎁", "#FFD93D", "expense", "", True, 7),
    Category("exp_other", "其他", "📦", "#D4D4D4", "expense", "", True, 99),
]

DEFAULT_INCOME_CATEGORIES = [
    Category("inc_salary", "工资", "💰", "#52B788", "income", "", True, 0),
    Category("inc_bonus", "奖金", "🎉", "#95D5B2", "income", "", True, 1),
    Category("inc_freelance", "兼职", "💼", "#74C69D", "income", "", True, 2),
    Category("inc_investment", "投资", "📈", "#40916C", "income", "", True, 3),
    Category("inc_gift", "红包", "🧧", "#FF6B6B", "income", "", True, 4),
    Category("inc_refund", "退款", "↩️", "#4ECDC4", "income", "", True, 5),
    Category("inc_other", "其他", "📦", "#D4D4D4", "income", "", True, 99),
]

DEFAULT_TAGS = [
    Tag("tag_necessary", "必要", "", True),
    Tag("tag_impulse", "冲动消费", "", True),
    Tag("tag_planned", "计划内", "", True),
]

DEFAULT_ACCOUNTS = [
    Account("acc_cash", "现金", "cash", "💵", "#FFB7B2", 0.0, 0, 0, 0, "", True, 0),
]

DEFAULT_LEDGER = Ledger("ledger_default", "日常生活", "🏠", "#FFB7B2", True, False, "")


class BookkeepingService:
    """本地 JSON 记账服务。

    这个类相当于项目里的 service + repository 合体：
    - 对上提供可直接被 Api 调用的业务方法。
    - 对下直接读写 records/categories/accounts 等 JSON 文件。
    """

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.records_file = data_dir / "records.json"
        self.categories_file = data_dir / "categories.json"
        self.tags_file = data_dir / "tags.json"
        self.accounts_file = data_dir / "accounts.json"
        self.budgets_file = data_dir / "budgets.json"
        self.ledgers_file = data_dir / "ledgers.json"
        # 初始化时就确保基础数据文件存在，避免前端首次进入页面就因为缺文件报错。
        self._ensure_files()

    def _ensure_files(self):
        """确保数据目录和基础 JSON 文件存在。"""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if not self.records_file.exists():
            self.records_file.write_text("[]", encoding="utf-8")
        if not self.categories_file.exists():
            default_cats = DEFAULT_EXPENSE_CATEGORIES + DEFAULT_INCOME_CATEGORIES
            self._save_categories(default_cats)
        if not self.tags_file.exists():
            self._save_tags(DEFAULT_TAGS)
        if not self.accounts_file.exists():
            self._save_accounts(DEFAULT_ACCOUNTS)
        if not self.budgets_file.exists():
            self.budgets_file.write_text("[]", encoding="utf-8")
        if not self.ledgers_file.exists():
            default_ledger = DEFAULT_LEDGER
            default_ledger.created_at = datetime.now().isoformat()
            self._save_ledgers([default_ledger])

    # ========== 通用读写 ==========
    # 这是最底层的磁盘访问能力，任何实体最终都会落到这里。
    def _load_json(self, file: Path) -> List[Dict]:
        # 当前项目约定所有业务数据都以 UTF-8 JSON 数组形式保存。
        return json.loads(file.read_text(encoding="utf-8"))

    def _save_json(self, file: Path, data: List):
        """原子保存JSON文件，避免写入中断导致文件损坏"""
        payload = json.dumps(
            [asdict(d) if hasattr(d, '__dataclass_fields__') else d for d in data],
            ensure_ascii=False, indent=2
        )
        tmp_file = file.with_suffix(file.suffix + ".tmp")
        tmp_file.write_text(payload, encoding="utf-8")
        tmp_file.replace(file)

    # ========== 数据完整性辅助 ==========
    def _get_default_category_id(self, cat_type: str) -> str:
        """获取默认兜底分类ID"""
        return "exp_other" if cat_type == "expense" else "inc_other"

    def _collect_category_tree_ids(self, root_id: str) -> set:
        """收集指定分类及其所有子分类ID"""
        cats = self._load_categories()
        cats_map = {c.id: c for c in cats}
        ids = set()
        stack = [root_id]
        while stack:
            cid = stack.pop()
            if cid in ids or cid not in cats_map:
                continue
            ids.add(cid)
            for c in cats:
                if c.parent_id == cid:
                    stack.append(c.id)
        return ids

    def _get_period_range_by_date(self, date_str: str, period: str) -> tuple:
        """根据指定日期与周期返回起止日期"""
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        if period == "year":
            return f"{dt.year}-01-01", f"{dt.year}-12-31"
        _, last_day = monthrange(dt.year, dt.month)
        return f"{dt.year}-{dt.month:02d}-01", f"{dt.year}-{dt.month:02d}-{last_day:02d}"

    def _check_budget_warnings(self, date_str: str, ledger_id: str, category_id: str, amount: float) -> List[Dict]:
        """检查新增支出是否会触发预算超限。

        该方法只负责“预警计算”，不会直接拦截保存；前端是否弹窗提示由 add_record 的返回值决定。
        """
        try:
            datetime.strptime(date_str, "%Y-%m-%d")
        except Exception:
            return []

        budgets = self._load_budgets()
        # 只统计当前账本的预算（空表示默认账本）
        if ledger_id:
            budgets = [b for b in budgets if b.ledger_id == ledger_id]
        else:
            budgets = [b for b in budgets if not b.ledger_id]

        records = [r for r in self._load_records() if r.type == "expense"]
        # 只统计当前账本的支出记录（空表示默认账本）
        if ledger_id:
            records = [r for r in records if r.ledger_id == ledger_id]
        else:
            records = [r for r in records if not r.ledger_id]

        warnings = []
        for b in budgets:
            if b.amount <= 0:
                continue
            start, end = self._get_period_range_by_date(date_str, b.period)
            scope_records = [r for r in records if start <= r.date <= end]

            if b.type == "total":
                used_before = sum(r.amount for r in scope_records)
                affects = True
            else:
                cat_ids = self._collect_category_tree_ids(b.category_id) if b.category_id else set()
                affects = category_id in cat_ids
                used_before = sum(r.amount for r in scope_records if r.category_id in cat_ids)

            if not affects:
                continue

            used_after = used_before + amount
            pct_before = round(used_before / b.amount * 100, 1)
            pct_after = round(used_after / b.amount * 100, 1)

            # 超过80%就警告
            if pct_after >= 80:
                warnings.append({
                    "budget_id": b.id,
                    "budget_name": b.name,
                    "period": b.period,
                    "amount": b.amount,
                    "used_before": round(used_before, 2),
                    "used_after": round(used_after, 2),
                    "pct_before": pct_before,
                    "pct_after": pct_after,
                    "will_exceed": pct_after > 100,
                    "exceed_by": round(max(0, used_after - b.amount), 2),
                })
        return warnings

    # ========== 分类管理（含多级） ==========
    # 对应前端：记一笔页分类网格、分类管理页、预算分类选择器。
    def _load_categories(self) -> List[Category]:
        data = self._load_json(self.categories_file)
        return [Category(**{k: v for k, v in item.items() if k in Category.__dataclass_fields__}) for item in data]

    def _save_categories(self, categories: List[Category]):
        self._save_json(self.categories_file, categories)

    def get_categories(self, type_filter: str = "", include_children: bool = True) -> List[Dict]:
        # include_children=True 时返回顶级分类 + children，供页面直接渲染树状/分组视图。
        cats = self._load_categories()
        if type_filter:
            cats = [c for c in cats if c.type == type_filter]

        result = []
        for c in sorted(cats, key=lambda x: x.order):
            d = asdict(c)
            if include_children and not c.parent_id:
                d["children"] = [asdict(sub) for sub in cats if sub.parent_id == c.id]
            if not c.parent_id or not include_children:
                result.append(d)
        return result

    def get_flat_categories(self, type_filter: str = "") -> List[Dict]:
        """获取扁平化的分类列表（不含层级结构）"""
        cats = self._load_categories()
        if type_filter:
            cats = [c for c in cats if c.type == type_filter]
        return [asdict(c) for c in sorted(cats, key=lambda x: (x.parent_id, x.order))]

    def add_category(self, name: str, icon: str, color: str, cat_type: str, parent_id: str = "") -> Dict:
        name = validate_string(name, "分类名称", MAX_NAME_LENGTH)
        cats = self._load_categories()
        type_cats = [c for c in cats if c.type == cat_type and c.parent_id == parent_id]
        max_order = max((c.order for c in type_cats if c.order < ORDER_OTHER_CATEGORY), default=-1) + 1
        prefix = "exp" if cat_type == "expense" else "inc"
        new_id = generate_unique_id(prefix)
        new_cat = Category(id=new_id, name=name, icon=icon, color=color, type=cat_type, parent_id=parent_id, is_system=False, order=max_order)
        cats.append(new_cat)
        self._save_categories(cats)
        return asdict(new_cat)

    def update_category(self, id: str, name: str, icon: str, color: str) -> Optional[Dict]:
        cats = self._load_categories()
        for i, cat in enumerate(cats):
            if cat.id == id:
                cats[i] = Category(id=id, name=name, icon=icon, color=color, type=cat.type, parent_id=cat.parent_id, is_system=cat.is_system, order=cat.order)
                self._save_categories(cats)
                return asdict(cats[i])
        return None

    def delete_category(self, id: str, strategy: str = "check", migrate_to: str = "") -> Dict:
        """
        删除分类并处理引用关系。
        strategy: check(检查引用) | migrate(迁移到目标分类) | cascade(级联删除)

        这是一个带数据完整性保护的删除入口：
        - check 只做影响面探测，供前端弹出确认框。
        - migrate 会把记录/预算迁移到其他分类。
        - cascade 会真正删掉关联记录和预算。
        """
        cats = self._load_categories()
        cats_map = {c.id: c for c in cats}
        cat = cats_map.get(id)

        if not cat:
            return {"success": False, "message": "分类不存在"}
        if cat.is_system:
            return {"success": False, "message": "系统分类不可删除"}

        if strategy not in {"check", "migrate", "cascade", "delete"}:
            return {"success": False, "message": "删除策略无效"}

        # 收集要删除的分类ID（包含子分类）
        ids_to_delete = self._collect_category_tree_ids(id)
        records = self._load_records()
        budgets = self._load_budgets()
        affected_records = [r for r in records if r.category_id in ids_to_delete]
        affected_budgets = [b for b in budgets if b.type == "category" and b.category_id in ids_to_delete]

        # 检查模式：返回影响范围
        if strategy == "check":
            if affected_records or affected_budgets:
                return {
                    "success": False,
                    "needs_confirm": True,
                    "affected_records": len(affected_records),
                    "affected_budgets": len(affected_budgets),
                    "category_name": cat.name,
                    "category_type": cat.type,
                    "suggested_migrate_to": self._get_default_category_id(cat.type),
                    "message": f"该分类下有 {len(affected_records)} 条记录和 {len(affected_budgets)} 个预算",
                }
            # 无引用，直接删除
            strategy = "delete"

        # 迁移模式
        if strategy == "migrate":
            target_id = migrate_to or self._get_default_category_id(cat.type)
            if target_id in ids_to_delete or target_id not in cats_map:
                return {"success": False, "message": "迁移目标分类无效"}
            for r in records:
                if r.category_id in ids_to_delete:
                    r.category_id = target_id
            for b in budgets:
                if b.type == "category" and b.category_id in ids_to_delete:
                    b.category_id = target_id
            self._save_records(records)
            self._save_budgets(budgets)

        # 级联删除模式
        elif strategy == "cascade":
            for r in affected_records:
                if r.account_id:
                    self._update_account_balance(r.account_id, r.amount, r.type != "expense")
            records = [r for r in records if r.category_id not in ids_to_delete]
            budgets = [b for b in budgets if not (b.type == "category" and b.category_id in ids_to_delete)]
            self._save_records(records)
            self._save_budgets(budgets)

        # 删除分类
        new_cats = [c for c in cats if c.id not in ids_to_delete]
        self._save_categories(new_cats)

        return {
            "success": True,
            "action": strategy,
            "affected_records": len(affected_records),
            "affected_budgets": len(affected_budgets),
            "message": "删除成功",
        }

    # ========== 标签管理 ==========
    # 标签目前主要附着在记录上，因此删除标签时要顺带清理记录里的 tag 引用。
    def _load_tags(self) -> List[Tag]:
        return [Tag(**item) for item in self._load_json(self.tags_file)]

    def _save_tags(self, tags: List[Tag]):
        self._save_json(self.tags_file, tags)

    def get_tags(self, category_id: str = "") -> List[Dict]:
        tags = self._load_tags()
        if category_id:
            tags = [t for t in tags if t.category_id == category_id or t.category_id == ""]
        return [asdict(t) for t in tags]

    def add_tag(self, name: str, category_id: str = "") -> Dict:
        name = validate_string(name, "标签名称", MAX_NAME_LENGTH)
        tags = self._load_tags()
        new_id = generate_unique_id("tag")
        new_tag = Tag(id=new_id, name=name, category_id=category_id, is_system=False)
        tags.append(new_tag)
        self._save_tags(tags)
        return asdict(new_tag)

    def delete_tag(self, id: str) -> Dict:
        """删除标签，并从所有记录中移除该标签引用"""
        tags = self._load_tags()
        tag = next((t for t in tags if t.id == id), None)

        if not tag:
            return {"success": False, "message": "标签不存在"}
        if tag.is_system:
            return {"success": False, "message": "系统标签不可删除"}

        # 从所有记录中移除该标签
        records = self._load_records()
        affected_count = 0
        for r in records:
            tag_list = r.tags if isinstance(r.tags, list) else []
            if id in tag_list:
                r.tags = [tid for tid in tag_list if tid != id]
                affected_count += 1
        if affected_count:
            self._save_records(records)

        self._save_tags([t for t in tags if t.id != id])
        return {
            "success": True,
            "affected_records": affected_count,
            "message": f"删除成功，已从 {affected_count} 条记录中移除",
        }

    # ========== 账户管理 ==========
    # 对应前端：账户卡片、记一笔账户下拉、转账弹窗、余额调整弹窗。
    def _load_accounts(self) -> List[Account]:
        data = self._load_json(self.accounts_file)
        return [Account(**{k: v for k, v in item.items() if k in Account.__dataclass_fields__}) for item in data]

    def _save_accounts(self, accounts: List[Account]):
        self._save_json(self.accounts_file, accounts)

    def get_accounts(self) -> List[Dict]:
        return [asdict(a) for a in sorted(self._load_accounts(), key=lambda x: x.order)]

    def add_account(self, name: str, acc_type: str, icon: str, color: str, balance: float = 0.0, credit_limit: float = 0.0, billing_day: int = 0, repayment_day: int = 0, note: str = "") -> Dict:
        name = validate_string(name, "账户名称", MAX_NAME_LENGTH)
        if acc_type not in VALID_ACCOUNT_TYPES:
            raise ValueError(f"无效的账户类型: {acc_type}")
        validated_balance = decimal_to_float(validate_amount(balance, allow_zero=True))

        accounts = self._load_accounts()
        new_id = generate_unique_id("acc")
        max_order = max((a.order for a in accounts), default=-1) + 1
        new_acc = Account(id=new_id, name=name, type=acc_type, icon=icon, color=color, balance=validated_balance, credit_limit=credit_limit, billing_day=billing_day, repayment_day=repayment_day, note=note, is_default=False, order=max_order)
        accounts.append(new_acc)
        self._save_accounts(accounts)
        return asdict(new_acc)

    def update_account(self, id: str, name: str, icon: str, color: str, balance: float = None, credit_limit: float = None, billing_day: int = None, repayment_day: int = None, note: str = None) -> Optional[Dict]:
        accounts = self._load_accounts()
        for i, acc in enumerate(accounts):
            if acc.id == id:
                accounts[i] = Account(
                    id=id, name=name, type=acc.type, icon=icon, color=color,
                    balance=balance if balance is not None else acc.balance,
                    credit_limit=credit_limit if credit_limit is not None else acc.credit_limit,
                    billing_day=billing_day if billing_day is not None else acc.billing_day,
                    repayment_day=repayment_day if repayment_day is not None else acc.repayment_day,
                    note=note if note is not None else acc.note,
                    is_default=acc.is_default, order=acc.order
                )
                self._save_accounts(accounts)
                return asdict(accounts[i])
        return None

    def delete_account(self, id: str, strategy: str = "check", migrate_to: str = "") -> Dict:
        """
        删除账户并处理引用关系。
        strategy: check(检查引用) | migrate(迁移到目标账户) | nullify(置空) | cascade(级联删除)

        排查“删账户后数据为什么变了”时，优先看这里：
        - migrate 会迁记录并合并余额。
        - nullify 会保留记录但清空 account_id。
        - cascade 会直接删除该账户关联记录。
        """
        accounts = self._load_accounts()
        acc_map = {a.id: a for a in accounts}
        acc = acc_map.get(id)

        if not acc:
            return {"success": False, "message": "账户不存在"}
        if acc.is_default:
            return {"success": False, "message": "默认账户不可删除"}

        if strategy not in {"check", "migrate", "nullify", "cascade", "delete"}:
            return {"success": False, "message": "删除策略无效"}

        records = self._load_records()
        affected_records = [r for r in records if r.account_id == id]
        default_acc = next((a for a in accounts if a.is_default), None)

        # 检查模式
        if strategy == "check":
            if affected_records or acc.balance != 0:
                return {
                    "success": False,
                    "needs_confirm": True,
                    "affected_records": len(affected_records),
                    "current_balance": acc.balance,
                    "account_name": acc.name,
                    "suggested_migrate_to": default_acc.id if default_acc else "",
                    "message": f"该账户有 {len(affected_records)} 条记录，余额 ¥{acc.balance}",
                }
            strategy = "delete"

        # 迁移模式：记录和余额都迁移到目标账户
        if strategy == "migrate":
            target_id = migrate_to or (default_acc.id if default_acc else "")
            if not target_id or target_id == id or target_id not in acc_map:
                return {"success": False, "message": "迁移目标账户无效"}

            for r in records:
                if r.account_id == id:
                    r.account_id = target_id
            self._save_records(records)

            # 余额合并
            target_acc = acc_map[target_id]
            target_acc.balance = round(target_acc.balance + acc.balance, 2)

        # 置空模式：记录保留但account_id清空
        elif strategy == "nullify":
            for r in records:
                if r.account_id == id:
                    r.account_id = ""
            self._save_records(records)

        # 级联删除模式
        elif strategy == "cascade":
            records = [r for r in records if r.account_id != id]
            self._save_records(records)

        # 删除账户
        accounts = [a for a in accounts if a.id != id]
        self._save_accounts(accounts)

        return {
            "success": True,
            "action": strategy,
            "affected_records": len(affected_records),
            "transferred_balance": acc.balance if strategy == "migrate" else 0,
            "message": "删除成功",
        }

    def get_total_assets(self) -> Dict:
        """获取总资产（所有账户余额汇总）"""
        accounts = self._load_accounts()
        total = sum(a.balance for a in accounts if a.type != "credit")
        credit_debt = sum(abs(a.balance) for a in accounts if a.type == "credit" and a.balance < 0)
        return {"total_assets": round(total, 2), "credit_debt": round(credit_debt, 2), "net_assets": round(total - credit_debt, 2)}

    def _update_account_balance(self, account_id: str, amount: Union[float, Decimal], is_expense: bool):
        """更新账户余额（使用 Decimal 避免浮点精度问题）。

        几乎所有会影响余额的流程都会收敛到这里，是排查余额异常时的核心入口。
        """
        if not account_id:
            return
        accounts = self._load_accounts()
        for acc in accounts:
            if acc.id == account_id:
                # 使用Decimal进行精确计算
                balance = Decimal(str(acc.balance))
                amount_decimal = Decimal(str(amount))
                if is_expense:
                    balance -= amount_decimal
                else:
                    balance += amount_decimal
                # 保留2位小数并转回float存储
                acc.balance = float(balance.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
                break
        self._save_accounts(accounts)

    # ========== 预算管理 ==========
    # 对应前端：预算页面、预算提醒、记一笔保存后的超支提示。
    def _load_budgets(self) -> List[Budget]:
        return [Budget(**item) for item in self._load_json(self.budgets_file)]

    def _save_budgets(self, budgets: List[Budget]):
        self._save_json(self.budgets_file, budgets)

    def get_budgets(self, ledger_id: str = "") -> List[Dict]:
        budgets = self._load_budgets()
        if ledger_id:
            budgets = [b for b in budgets if b.ledger_id == ledger_id]
        return [asdict(b) for b in budgets]

    def add_budget(self, name: str, budget_type: str, amount: float, category_id: str = "", period: str = "month", ledger_id: str = "") -> Dict:
        name = validate_string(name, "预算名称", MAX_NAME_LENGTH)
        if budget_type not in VALID_BUDGET_TYPES:
            raise ValueError(f"无效的预算类型: {budget_type}")
        if period not in VALID_BUDGET_PERIODS:
            raise ValueError(f"无效的预算周期: {period}")
        validated_amount = decimal_to_float(validate_amount(amount))

        budgets = self._load_budgets()
        new_id = generate_unique_id("budget")
        new_budget = Budget(id=new_id, name=name, type=budget_type, category_id=category_id, amount=validated_amount, period=period, ledger_id=ledger_id)
        budgets.append(new_budget)
        self._save_budgets(budgets)
        return asdict(new_budget)

    def update_budget(self, id: str, name: str, amount: float) -> Optional[Dict]:
        budgets = self._load_budgets()
        for i, b in enumerate(budgets):
            if b.id == id:
                budgets[i] = Budget(id=id, name=name, type=b.type, category_id=b.category_id, amount=amount, period=b.period, ledger_id=b.ledger_id)
                self._save_budgets(budgets)
                return asdict(budgets[i])
        return None

    def delete_budget(self, id: str) -> bool:
        budgets = self._load_budgets()
        new_budgets = [b for b in budgets if b.id != id]
        if len(new_budgets) < len(budgets):
            self._save_budgets(new_budgets)
            return True
        return False

    def get_budget_status(self, ledger_id: str = "") -> List[Dict]:
        """获取预算使用情况。

        这里会按预算周期预先切出月度/年度记录集，再按预算类型计算 used / remaining / percentage。
        """
        budgets = self._load_budgets()
        if ledger_id:
            budgets = [b for b in budgets if b.ledger_id == ledger_id]

        today = datetime.now()
        # 计算月度范围
        month_start = today.replace(day=1).strftime("%Y-%m-%d")
        if today.month == 12:
            month_end_dt = today.replace(year=today.year + 1, month=1, day=1) - timedelta(days=1)
        else:
            month_end_dt = today.replace(month=today.month + 1, day=1) - timedelta(days=1)
        month_end = month_end_dt.strftime("%Y-%m-%d")
        # 计算年度范围
        year_start = f"{today.year}-01-01"
        year_end = f"{today.year}-12-31"

        # 加载记录并按账本过滤
        all_records = [r for r in self._load_records() if r.type == "expense"]
        if ledger_id:
            all_records = [r for r in all_records if r.ledger_id == ledger_id]
        # 预过滤月度和年度记录以减少重复计算
        month_records = [r for r in all_records if month_start <= r.date <= month_end]
        year_records = [r for r in all_records if year_start <= r.date <= year_end]

        cats = {c.id: c for c in self._load_categories()}
        result = []

        for b in budgets:
            # 根据预算period选择对应的记录集
            records = year_records if b.period == "year" else month_records

            if b.type == "total":
                used = sum(r.amount for r in records)
            else:
                # 分类预算，包含子分类
                cat_ids = {b.category_id}
                for c in cats.values():
                    if c.parent_id == b.category_id:
                        cat_ids.add(c.id)
                used = sum(r.amount for r in records if r.category_id in cat_ids)

            percentage = round(used / b.amount * 100, 1) if b.amount > 0 else 0
            remaining = round(b.amount - used, 2)

            result.append({
                "id": b.id,
                "name": b.name,
                "type": b.type,
                "category_id": b.category_id,
                "amount": b.amount,
                "period": b.period,
                "used": round(used, 2),
                "remaining": remaining,
                "percentage": percentage,
                "is_over": percentage > 100,
                "is_warning": 80 <= percentage <= 100,
            })

        return result

    # ========== 账本管理 ==========
    # 对应前端：侧边栏账本切换器、账本卡片列表。
    def _load_ledgers(self) -> List[Ledger]:
        return [Ledger(**item) for item in self._load_json(self.ledgers_file)]

    def _save_ledgers(self, ledgers: List[Ledger]):
        self._save_json(self.ledgers_file, ledgers)

    def get_ledgers(self, include_archived: bool = False) -> List[Dict]:
        ledgers = self._load_ledgers()
        if not include_archived:
            ledgers = [l for l in ledgers if not l.is_archived]
        return [asdict(l) for l in ledgers]

    def add_ledger(self, name: str, icon: str, color: str) -> Dict:
        name = validate_string(name, "账本名称", MAX_NAME_LENGTH)
        ledgers = self._load_ledgers()
        new_id = generate_unique_id("ledger")
        new_ledger = Ledger(id=new_id, name=name, icon=icon, color=color, is_default=False, is_archived=False, created_at=datetime.now().isoformat())
        ledgers.append(new_ledger)
        self._save_ledgers(ledgers)
        return asdict(new_ledger)

    def update_ledger(self, id: str, name: str, icon: str, color: str) -> Optional[Dict]:
        ledgers = self._load_ledgers()
        for i, l in enumerate(ledgers):
            if l.id == id:
                ledgers[i] = Ledger(id=id, name=name, icon=icon, color=color, is_default=l.is_default, is_archived=l.is_archived, created_at=l.created_at)
                self._save_ledgers(ledgers)
                return asdict(ledgers[i])
        return None

    def archive_ledger(self, id: str) -> bool:
        ledgers = self._load_ledgers()
        for l in ledgers:
            if l.id == id and not l.is_default:
                l.is_archived = True
                self._save_ledgers(ledgers)
                return True
        return False

    def delete_ledger(self, id: str) -> bool:
        # 删除账本不仅是删 ledgers.json 条目，还要一并清理该账本下的记录/预算，
        # 并先回滚这些记录对账户余额产生的历史影响。
        ledgers = self._load_ledgers()
        ledger = next((l for l in ledgers if l.id == id), None)
        if not ledger or ledger.is_default:
            return False
        # 回滚该账本下记录对账户余额的影响
        records = self._load_records()
        ledger_records = [r for r in records if r.ledger_id == id]
        for rec in ledger_records:
            if rec.account_id:
                self._update_account_balance(rec.account_id, rec.amount, rec.type != "expense")
        # 删除该账本下的所有记录和预算
        records = [r for r in records if r.ledger_id != id]
        self._save_records(records)
        self._save_budgets([b for b in self._load_budgets() if b.ledger_id != id])
        self._save_ledgers([l for l in ledgers if l.id != id])
        return True

    # ========== 记录管理 ==========
    # 这是页面最频繁访问的区域：首页最近记录、记一笔、账单明细、编辑弹窗都依赖这里。
    def _load_records(self) -> List[Record]:
        data = self._load_json(self.records_file)
        return [Record(**{k: v for k, v in item.items() if k in Record.__dataclass_fields__}) for item in data]

    def _save_records(self, records: List[Record]):
        self._save_json(self.records_file, records)

    def get_records(self, start_date: str = "", end_date: str = "", type_filter: str = "", category_id: str = "", account_id: str = "", ledger_id: str = "", limit: int = 0) -> List[Dict]:
        # 这个查询结果会被前端直接用于渲染，因此这里顺手补上 category/account 的展示信息，
        # 避免前端再二次 join。
        records = self._load_records()
        cats = {c.id: c for c in self._load_categories()}
        accounts = {a.id: a for a in self._load_accounts()}

        if start_date:
            records = [r for r in records if r.date >= start_date]
        if end_date:
            records = [r for r in records if r.date <= end_date]
        if type_filter:
            records = [r for r in records if r.type == type_filter]
        if category_id:
            # 包含子分类
            cat_ids = {category_id}
            for c in cats.values():
                if c.parent_id == category_id:
                    cat_ids.add(c.id)
            records = [r for r in records if r.category_id in cat_ids]
        if account_id:
            records = [r for r in records if r.account_id == account_id]
        if ledger_id:
            records = [r for r in records if r.ledger_id == ledger_id]

        records = sorted(records, key=lambda x: (x.date, x.time or "00:00"), reverse=True)

        if limit > 0:
            records = records[:limit]

        result = []
        for r in records:
            d = asdict(r)
            if r.category_id in cats:
                d["category"] = asdict(cats[r.category_id])
            if r.account_id in accounts:
                d["account"] = asdict(accounts[r.account_id])
            result.append(d)
        return result

    def add_record(self, rec_type: str, amount: float, category_id: str, date: str, time: str = "", note: str = "", tags: List[str] = None, account_id: str = "", ledger_id: str = "") -> Dict:
        """新增一条收支记录。

        关键链路：
        1. 校验输入并补默认账户。
        2. 先做预算提醒计算。
        3. 先保存记录，再更新账户余额。
        4. 若余额更新失败，则回滚刚写入的记录。
        """
        # ========== 输入验证 ==========
        if rec_type not in VALID_RECORD_TYPES:
            raise ValueError(f"无效的记录类型: {rec_type}，必须是 income 或 expense")

        validated_amount = validate_amount(amount)
        validated_date = validate_date(date)
        validated_time = validate_time(time)
        validated_note = validate_string(note, "备注", MAX_NOTE_LENGTH, allow_empty=True)

        records = self._load_records()
        now = datetime.now().isoformat()
        new_id = generate_unique_id("rec")

        # 默认账户
        if not account_id:
            accounts = self._load_accounts()
            default_acc = next((a for a in accounts if a.is_default), None)
            account_id = default_acc.id if default_acc else ""

        float_amount = decimal_to_float(validated_amount)

        # 预算超支检查（仅支出）
        budget_warnings = []
        if rec_type == "expense":
            budget_warnings = self._check_budget_warnings(validated_date, ledger_id, category_id, float_amount)

        new_record = Record(
            id=new_id, type=rec_type, amount=float_amount, category_id=category_id,
            account_id=account_id, ledger_id=ledger_id,
            date=validated_date, time=validated_time or datetime.now().strftime("%H:%M"),
            note=validated_note, tags=tags or [], created_at=now, updated_at=now,
        )

        # ========== 事务一致性：先保存记录，成功后再更新余额 ==========
        records.append(new_record)
        try:
            self._save_records(records)
        except Exception as e:
            # 记录保存失败，不更新余额
            raise ValueError(f"保存记录失败: {e}")

        # 记录保存成功后，更新账户余额
        if account_id:
            try:
                self._update_account_balance(account_id, validated_amount, rec_type == "expense")
            except Exception as e:
                # 余额更新失败，回滚记录
                records = [r for r in records if r.id != new_id]
                self._save_records(records)
                raise ValueError(f"更新账户余额失败: {e}")

        # 返回带关联信息的记录
        cats = {c.id: c for c in self._load_categories()}
        accounts_map = {a.id: a for a in self._load_accounts()}
        d = asdict(new_record)
        if category_id in cats:
            d["category"] = asdict(cats[category_id])
        if account_id in accounts_map:
            d["account"] = asdict(accounts_map[account_id])

        # 附加预算警告
        d["budget_warnings"] = budget_warnings
        d["has_budget_warning"] = bool(budget_warnings)
        return d

    def update_record(self, id: str, rec_type: str, amount: float, category_id: str, date: str, time: str = "", note: str = "", tags: List[str] = None, account_id: str = "", ledger_id: str = "") -> Optional[Dict]:
        """更新已有记录，并重新结算账户余额影响。"""
        # ========== 输入验证 ==========
        if rec_type not in VALID_RECORD_TYPES:
            raise ValueError(f"无效的记录类型: {rec_type}，必须是 income 或 expense")

        validated_amount = validate_amount(amount)
        validated_date = validate_date(date)
        validated_time = validate_time(time)
        validated_note = validate_string(note, "备注", MAX_NOTE_LENGTH, allow_empty=True)

        records = self._load_records()
        old_record = None
        record_index = -1

        for i, rec in enumerate(records):
            if rec.id == id:
                old_record = rec
                record_index = i
                break

        if old_record is None:
            return None

        float_amount = decimal_to_float(validated_amount)
        new_acc_id = account_id or old_record.account_id
        new_ledger_id = ledger_id or old_record.ledger_id

        # 创建更新后的记录
        updated_record = Record(
            id=id, type=rec_type, amount=float_amount, category_id=category_id,
            account_id=new_acc_id, ledger_id=new_ledger_id,
            date=validated_date, time=validated_time or old_record.time,
            note=validated_note, tags=tags or [],
            created_at=old_record.created_at, updated_at=datetime.now().isoformat(),
        )

        # ========== 事务一致性：先保存记录，成功后再更新余额 ==========
        records[record_index] = updated_record
        try:
            self._save_records(records)
        except Exception as e:
            raise ValueError(f"保存记录失败: {e}")

        # 记录保存成功后，更新余额（先回滚旧余额，再应用新余额）
        try:
            # 回滚旧记录的余额影响
            if old_record.account_id:
                self._update_account_balance(
                    old_record.account_id, old_record.amount, old_record.type != "expense"
                )
            # 应用新记录的余额影响
            if new_acc_id:
                self._update_account_balance(new_acc_id, validated_amount, rec_type == "expense")
        except Exception as e:
            # 余额更新失败，回滚记录修改
            records[record_index] = old_record
            self._save_records(records)
            raise ValueError(f"更新账户余额失败: {e}")

        # 返回带关联信息的记录
        cats = {c.id: c for c in self._load_categories()}
        accounts_map = {a.id: a for a in self._load_accounts()}
        d = asdict(updated_record)
        if category_id in cats:
            d["category"] = asdict(cats[category_id])
        if new_acc_id in accounts_map:
            d["account"] = asdict(accounts_map[new_acc_id])
        return d

    def delete_record(self, id: str) -> bool:
        # 删除记录前要先回滚它对账户余额的影响，否则账户卡片会与明细不一致。
        records = self._load_records()
        rec = next((r for r in records if r.id == id), None)
        if not rec:
            return False

        # 回滚账户余额
        if rec.account_id:
            self._update_account_balance(rec.account_id, rec.amount, rec.type != "expense")

        self._save_records([r for r in records if r.id != id])
        return True

    # ========== 账户转账 ==========
    # 账户转账不会生成 Record，而是直接调整两个账户余额并把结果回给前端弹窗。
    def transfer(self, from_account_id: str, to_account_id: str, amount: float, date: str = "", note: str = "") -> Dict:
        """
        账户间转账，自动更新双方余额。
        从 from_account 扣减金额，向 to_account 增加金额。

        这个流程只影响账户余额，不会出现在普通收支记录列表中。
        """
        # 输入验证
        if not from_account_id:
            raise ValueError("请选择转出账户")
        if not to_account_id:
            raise ValueError("请选择转入账户")
        if from_account_id == to_account_id:
            raise ValueError("转出和转入账户不能相同")

        validated_amount = validate_amount(amount)
        validated_date = validate_date(date) if date else datetime.now().strftime("%Y-%m-%d")
        validated_note = validate_string(note, "备注", MAX_NOTE_LENGTH, allow_empty=True)

        # 验证账户存在
        accounts = self._load_accounts()
        acc_map = {a.id: a for a in accounts}
        from_acc = acc_map.get(from_account_id)
        to_acc = acc_map.get(to_account_id)

        if not from_acc:
            raise ValueError("转出账户不存在")
        if not to_acc:
            raise ValueError("转入账户不存在")

        float_amount = decimal_to_float(validated_amount)

        # 检查转出账户余额是否足够（信用卡账户允许透支）
        if from_acc.type != 'credit' and from_acc.balance < float_amount:
            raise ValueError(f"转出账户余额不足（当前 ¥{from_acc.balance:.2f}）")

        # 更新双方余额（使用 Decimal 精确计算）
        for acc in accounts:
            if acc.id == from_account_id:
                balance = Decimal(str(acc.balance))
                balance -= Decimal(str(float_amount))
                acc.balance = float(balance.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
            elif acc.id == to_account_id:
                balance = Decimal(str(acc.balance))
                balance += Decimal(str(float_amount))
                acc.balance = float(balance.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

        self._save_accounts(accounts)

        # 返回转账结果
        updated_accounts = {a.id: a for a in accounts}
        return {
            "success": True,
            "amount": float_amount,
            "date": validated_date,
            "note": validated_note,
            "from_account": {
                "id": from_account_id,
                "name": from_acc.name,
                "icon": from_acc.icon,
                "balance": updated_accounts[from_account_id].balance,
            },
            "to_account": {
                "id": to_account_id,
                "name": to_acc.name,
                "icon": to_acc.icon,
                "balance": updated_accounts[to_account_id].balance,
            },
        }

    def adjust_balance(self, account_id: str, new_balance: float, note: str = "") -> Dict:
        """
        手动调整账户余额（对账校正）。
        直接将账户余额设置为新值，用于与实际余额对账。

        这里不会补一条校正 Record，只返回变更前后的余额差值供前端展示。
        """
        if not account_id:
            raise ValueError("请选择账户")

        validated_balance = validate_amount(new_balance, allow_zero=True)
        validated_note = validate_string(note, "备注", MAX_NOTE_LENGTH, allow_empty=True)

        accounts = self._load_accounts()
        acc = next((a for a in accounts if a.id == account_id), None)

        if not acc:
            raise ValueError("账户不存在")

        old_balance = acc.balance
        new_balance_float = decimal_to_float(validated_balance)
        difference = round(new_balance_float - old_balance, 2)

        # 更新余额
        acc.balance = new_balance_float
        self._save_accounts(accounts)

        return {
            "success": True,
            "account_id": account_id,
            "account_name": acc.name,
            "account_icon": acc.icon,
            "old_balance": old_balance,
            "new_balance": new_balance_float,
            "difference": difference,
            "note": validated_note,
        }

    # ========== 智能推荐 ==========
    # 推荐结果来自历史消费频率 + 当前时段，不依赖额外模型。
    def get_smart_suggestions(self) -> List[Dict]:
        """基于历史记录和时间推荐"""
        records = self._load_records()
        cats = {c.id: c for c in self._load_categories()}
        hour = datetime.now().hour

        # 统计常用分类和金额
        cat_amounts = defaultdict(list)
        for r in records:
            if r.type == "expense":
                cat_amounts[r.category_id].append(r.amount)

        suggestions = []

        # 基于时间推荐
        if 6 <= hour < 10:
            time_cats = ["exp_food_breakfast", "exp_transport_subway", "exp_transport_bus"]
        elif 11 <= hour < 14:
            time_cats = ["exp_food_lunch", "exp_food"]
        elif 17 <= hour < 20:
            time_cats = ["exp_food_dinner", "exp_transport"]
        elif 20 <= hour < 24:
            time_cats = ["exp_entertainment", "exp_food_snack"]
        else:
            time_cats = []

        for cat_id in time_cats:
            if cat_id in cats:
                amounts = cat_amounts.get(cat_id, [])
                avg_amount = round(sum(amounts) / len(amounts), 2) if amounts else 0
                cat = cats[cat_id]
                suggestions.append({
                    "category_id": cat_id,
                    "category_name": cat.name,
                    "category_icon": cat.icon,
                    "suggested_amount": avg_amount,
                    "reason": "time",
                })

        # 基于频率推荐（最常用的分类）
        freq = Counter(r.category_id for r in records if r.type == "expense")
        for cat_id, count in freq.most_common(3):
            if cat_id in cats and cat_id not in time_cats:
                amounts = cat_amounts.get(cat_id, [])
                avg_amount = round(sum(amounts) / len(amounts), 2) if amounts else 0
                cat = cats[cat_id]
                suggestions.append({
                    "category_id": cat_id,
                    "category_name": cat.name,
                    "category_icon": cat.icon,
                    "suggested_amount": avg_amount,
                    "reason": "frequent",
                })

        return suggestions[:5]

    # ========== 统计功能 ==========
    # 首页、统计页的图表和排行基本都从这里取数。
    def get_summary(self, start_date: str, end_date: str, ledger_id: str = "") -> Dict:
        # 汇总口径：收入与支出分开累加，再给出区间结余和记录数。
        records = self._load_records()
        records = [r for r in records if start_date <= r.date <= end_date]
        if ledger_id:
            records = [r for r in records if r.ledger_id == ledger_id]

        total_income = sum(r.amount for r in records if r.type == "income")
        total_expense = sum(r.amount for r in records if r.type == "expense")

        return {
            "start_date": start_date, "end_date": end_date,
            "total_income": round(total_income, 2),
            "total_expense": round(total_expense, 2),
            "balance": round(total_income - total_expense, 2),
            "record_count": len(records),
        }

    def get_daily_stats(self, start_date: str, end_date: str, ledger_id: str = "") -> List[Dict]:
        # 趋势图需要连续日期，因此即使某天没有记录，也会补 0 返回给前端。
        records = self._load_records()
        records = [r for r in records if start_date <= r.date <= end_date]
        if ledger_id:
            records = [r for r in records if r.ledger_id == ledger_id]

        daily = defaultdict(lambda: {"income": 0.0, "expense": 0.0})
        for r in records:
            daily[r.date][r.type] += r.amount

        result = []
        current = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d")
        while current <= end:
            date_str = current.strftime("%Y-%m-%d")
            d = daily.get(date_str, {"income": 0.0, "expense": 0.0})
            result.append({"date": date_str, "income": round(d["income"], 2), "expense": round(d["expense"], 2)})
            current += timedelta(days=1)
        return result

    def get_category_stats(self, start_date: str, end_date: str, rec_type: str = "expense", ledger_id: str = "") -> List[Dict]:
        # 分类占比图默认按父分类聚合，避免子分类过细导致饼图碎片化。
        records = self._load_records()
        records = [r for r in records if start_date <= r.date <= end_date and r.type == rec_type]
        if ledger_id:
            records = [r for r in records if r.ledger_id == ledger_id]
        cats = {c.id: c for c in self._load_categories()}

        by_cat = defaultdict(float)
        for r in records:
            # 归类到父分类
            cat = cats.get(r.category_id)
            if cat and cat.parent_id:
                by_cat[cat.parent_id] += r.amount
            else:
                by_cat[r.category_id] += r.amount

        total = sum(by_cat.values())
        result = []
        for cat_id, amount in sorted(by_cat.items(), key=lambda x: -x[1]):
            cat = cats.get(cat_id)
            if cat:
                result.append({
                    "category_id": cat_id, "category_name": cat.name,
                    "category_icon": cat.icon, "category_color": cat.color,
                    "amount": round(amount, 2),
                    "percentage": round(amount / total * 100, 1) if total > 0 else 0,
                })
        return result

    def get_monthly_stats(self, year: int, ledger_id: str = "") -> List[Dict]:
        # 年度趋势图固定返回 12 个月，缺数据的月份会补 0。
        records = self._load_records()
        year_str = str(year)
        records = [r for r in records if r.date.startswith(year_str)]
        if ledger_id:
            records = [r for r in records if r.ledger_id == ledger_id]

        monthly = defaultdict(lambda: {"income": 0.0, "expense": 0.0})
        for r in records:
            month = r.date[:7]
            monthly[month][r.type] += r.amount

        result = []
        for m in range(1, 13):
            month_str = f"{year}-{m:02d}"
            d = monthly.get(month_str, {"income": 0.0, "expense": 0.0})
            result.append({"month": month_str, "month_label": f"{m}月", "income": round(d["income"], 2), "expense": round(d["expense"], 2)})
        return result

    def get_weekly_stats(self, date: str = "", ledger_id: str = "") -> List[Dict]:
        # 周统计本质上是把任意日期折算到所属周的一周范围，再复用 get_daily_stats。
        if not date:
            date = datetime.now().strftime("%Y-%m-%d")
        dt = datetime.strptime(date, "%Y-%m-%d")
        monday = dt - timedelta(days=dt.weekday())
        sunday = monday + timedelta(days=6)
        return self.get_daily_stats(monday.strftime("%Y-%m-%d"), sunday.strftime("%Y-%m-%d"), ledger_id)

    def get_asset_trend(self, months: int = 6) -> List[Dict]:
        """获取资产趋势（按月）。

        算法不是回放每月快照，而是基于“当前账户总资产 - 该月之后的净变动”反推历史月末资产。
        """
        records = self._load_records()
        accounts = self._load_accounts()

        # 计算当前总资产
        current_assets = sum(a.balance for a in accounts)

        today = datetime.now()
        result = []
        base_year, base_month = today.year, today.month

        # 精确按自然月回溯
        for i in range(months - 1, -1, -1):
            month_index = base_year * 12 + base_month - 1 - i
            year_i, month_i = divmod(month_index, 12)
            month_i += 1
            _, last_day = monthrange(year_i, month_i)

            month_end_str = f"{year_i}-{month_i:02d}-{last_day:02d}"
            month_label = f"{month_i}月"

            # 计算该月末之后的所有收支变动
            later_records = [r for r in records if r.date > month_end_str]
            net_change = sum(r.amount if r.type == "income" else -r.amount for r in later_records)

            # 该月末的资产 = 当前资产 - 之后的净变动
            month_assets = current_assets - net_change

            result.append({"month": f"{year_i}-{month_i:02d}", "month_label": month_label, "assets": round(month_assets, 2)})

        return result

    # ========== 数据导出 ==========
    # 导出层不直接访问底层 JSON，而是复用上面的查询结果，保证导出口径和页面展示一致。
    def export_records_csv(self, start_date: str = "", end_date: str = "", ledger_id: str = "") -> str:
        """导出记录为 CSV 格式"""
        records = self.get_records(start_date, end_date, "", "", "", ledger_id, 0)

        output = StringIO()
        writer = csv.writer(output)
        writer.writerow(["日期", "时间", "类型", "分类", "金额", "备注", "账户"])

        for r in records:
            writer.writerow([
                r["date"],
                r.get("time", ""),
                "收入" if r["type"] == "income" else "支出",
                r.get("category", {}).get("name", ""),
                r["amount"],
                r.get("note", ""),
                r.get("account", {}).get("name", ""),
            ])

        return output.getvalue()

    def export_summary_csv(self, year: int, ledger_id: str = "") -> str:
        """导出年度月汇总为 CSV"""
        stats = self.get_monthly_stats(year, ledger_id)

        output = StringIO()
        writer = csv.writer(output)
        writer.writerow(["月份", "收入", "支出", "结余"])

        for s in stats:
            writer.writerow([s["month_label"], s["income"], s["expense"], round(s["income"] - s["expense"], 2)])

        return output.getvalue()
