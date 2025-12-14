"""测试转账和余额调整功能"""
import pytest
import tempfile
import shutil
from pathlib import Path
from decimal import Decimal

from services.bookkeeping import BookkeepingService


@pytest.fixture
def service():
    """创建临时目录的测试服务"""
    temp_dir = Path(tempfile.mkdtemp())
    svc = BookkeepingService(temp_dir)
    yield svc
    shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.fixture
def service_with_accounts(service):
    """带有测试账户的服务"""
    # 添加两个测试账户
    service.add_account("银行卡", "bank", "🏦", "#B5EAD7", 1000.0)
    service.add_account("支付宝", "bank", "📱", "#C7CEEA", 500.0)
    return service


class TestTransfer:
    """转账功能测试"""

    def test_transfer_basic(self, service_with_accounts):
        """基本转账测试"""
        accounts = service_with_accounts.get_accounts()
        from_acc = next(a for a in accounts if a["name"] == "银行卡")
        to_acc = next(a for a in accounts if a["name"] == "支付宝")

        result = service_with_accounts.transfer(
            from_acc["id"], to_acc["id"], 200.0, "", "测试转账"
        )

        assert result["success"] is True
        assert result["amount"] == 200.0
        assert result["from_account"]["balance"] == 800.0  # 1000 - 200
        assert result["to_account"]["balance"] == 700.0    # 500 + 200

    def test_transfer_decimal_precision(self, service_with_accounts):
        """转账精度测试"""
        accounts = service_with_accounts.get_accounts()
        from_acc = next(a for a in accounts if a["name"] == "银行卡")
        to_acc = next(a for a in accounts if a["name"] == "支付宝")

        result = service_with_accounts.transfer(
            from_acc["id"], to_acc["id"], 123.45, "", ""
        )

        assert result["success"] is True
        assert result["from_account"]["balance"] == 876.55  # 1000 - 123.45
        assert result["to_account"]["balance"] == 623.45   # 500 + 123.45

    def test_transfer_same_account_error(self, service_with_accounts):
        """转账到同一账户应报错"""
        accounts = service_with_accounts.get_accounts()
        acc = accounts[0]

        with pytest.raises(ValueError, match="不能相同"):
            service_with_accounts.transfer(acc["id"], acc["id"], 100.0)

    def test_transfer_invalid_account_error(self, service_with_accounts):
        """无效账户应报错"""
        accounts = service_with_accounts.get_accounts()

        with pytest.raises(ValueError, match="不存在"):
            service_with_accounts.transfer("invalid_id", accounts[0]["id"], 100.0)

        with pytest.raises(ValueError, match="不存在"):
            service_with_accounts.transfer(accounts[0]["id"], "invalid_id", 100.0)

    def test_transfer_zero_amount_error(self, service_with_accounts):
        """零金额应报错"""
        accounts = service_with_accounts.get_accounts()

        with pytest.raises(ValueError, match="不能为零"):
            service_with_accounts.transfer(
                accounts[0]["id"], accounts[1]["id"], 0
            )

    def test_transfer_negative_amount_error(self, service_with_accounts):
        """负金额应报错"""
        accounts = service_with_accounts.get_accounts()

        with pytest.raises(ValueError, match="不能为负"):
            service_with_accounts.transfer(
                accounts[0]["id"], accounts[1]["id"], -100.0
            )

    def test_transfer_empty_from_account_error(self, service_with_accounts):
        """空转出账户应报错"""
        accounts = service_with_accounts.get_accounts()

        with pytest.raises(ValueError, match="转出账户"):
            service_with_accounts.transfer("", accounts[0]["id"], 100.0)

    def test_transfer_empty_to_account_error(self, service_with_accounts):
        """空转入账户应报错"""
        accounts = service_with_accounts.get_accounts()

        with pytest.raises(ValueError, match="转入账户"):
            service_with_accounts.transfer(accounts[0]["id"], "", 100.0)


class TestAdjustBalance:
    """余额调整功能测试"""

    def test_adjust_balance_basic(self, service_with_accounts):
        """基本余额调整测试"""
        accounts = service_with_accounts.get_accounts()
        acc = next(a for a in accounts if a["name"] == "银行卡")

        result = service_with_accounts.adjust_balance(
            acc["id"], 1500.0, "对账调整"
        )

        assert result["success"] is True
        assert result["old_balance"] == 1000.0
        assert result["new_balance"] == 1500.0
        assert result["difference"] == 500.0

    def test_adjust_balance_decrease(self, service_with_accounts):
        """余额减少测试"""
        accounts = service_with_accounts.get_accounts()
        acc = next(a for a in accounts if a["name"] == "银行卡")

        result = service_with_accounts.adjust_balance(acc["id"], 800.0, "")

        assert result["success"] is True
        assert result["old_balance"] == 1000.0
        assert result["new_balance"] == 800.0
        assert result["difference"] == -200.0

    def test_adjust_balance_to_zero(self, service_with_accounts):
        """余额调整为零"""
        accounts = service_with_accounts.get_accounts()
        acc = next(a for a in accounts if a["name"] == "银行卡")

        result = service_with_accounts.adjust_balance(acc["id"], 0.0, "清零")

        assert result["success"] is True
        assert result["new_balance"] == 0.0
        assert result["difference"] == -1000.0

    def test_adjust_balance_decimal_precision(self, service_with_accounts):
        """余额调整精度测试"""
        accounts = service_with_accounts.get_accounts()
        acc = next(a for a in accounts if a["name"] == "银行卡")

        result = service_with_accounts.adjust_balance(acc["id"], 1234.56, "")

        assert result["success"] is True
        assert result["new_balance"] == 1234.56
        assert result["difference"] == 234.56

    def test_adjust_balance_invalid_account_error(self, service_with_accounts):
        """无效账户应报错"""
        with pytest.raises(ValueError, match="不存在"):
            service_with_accounts.adjust_balance("invalid_id", 100.0, "")

    def test_adjust_balance_empty_account_error(self, service_with_accounts):
        """空账户应报错"""
        with pytest.raises(ValueError, match="选择账户"):
            service_with_accounts.adjust_balance("", 100.0, "")

    def test_adjust_balance_negative_error(self, service_with_accounts):
        """负余额应报错"""
        accounts = service_with_accounts.get_accounts()
        acc = accounts[0]

        with pytest.raises(ValueError, match="不能为负"):
            service_with_accounts.adjust_balance(acc["id"], -100.0, "")

    def test_adjust_balance_persistence(self, service_with_accounts):
        """余额调整持久化测试"""
        accounts = service_with_accounts.get_accounts()
        acc = next(a for a in accounts if a["name"] == "银行卡")

        service_with_accounts.adjust_balance(acc["id"], 2000.0, "")

        # 重新获取账户验证持久化
        accounts_after = service_with_accounts.get_accounts()
        acc_after = next(a for a in accounts_after if a["name"] == "银行卡")
        assert acc_after["balance"] == 2000.0


class TestTransferAndAdjustIntegration:
    """转账和余额调整集成测试"""

    def test_transfer_then_adjust(self, service_with_accounts):
        """先转账再调整"""
        accounts = service_with_accounts.get_accounts()
        from_acc = next(a for a in accounts if a["name"] == "银行卡")
        to_acc = next(a for a in accounts if a["name"] == "支付宝")

        # 转账 300
        service_with_accounts.transfer(from_acc["id"], to_acc["id"], 300.0)

        # 调整银行卡余额
        result = service_with_accounts.adjust_balance(from_acc["id"], 1000.0, "")

        assert result["old_balance"] == 700.0  # 1000 - 300
        assert result["new_balance"] == 1000.0
        assert result["difference"] == 300.0

    def test_multiple_transfers(self, service_with_accounts):
        """多次转账累计"""
        accounts = service_with_accounts.get_accounts()
        from_acc = next(a for a in accounts if a["name"] == "银行卡")
        to_acc = next(a for a in accounts if a["name"] == "支付宝")

        # 多次转账
        service_with_accounts.transfer(from_acc["id"], to_acc["id"], 100.0)
        service_with_accounts.transfer(from_acc["id"], to_acc["id"], 200.0)
        result = service_with_accounts.transfer(from_acc["id"], to_acc["id"], 50.0)

        # 银行卡: 1000 - 100 - 200 - 50 = 650
        # 支付宝: 500 + 100 + 200 + 50 = 850
        assert result["from_account"]["balance"] == 650.0
        assert result["to_account"]["balance"] == 850.0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
