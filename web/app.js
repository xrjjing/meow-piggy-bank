/*
 * 前端主脚本总览
 * -----------------------------------------------------------------------------
 * 这是喵喵存金罐的唯一前端入口脚本，服务 web/index.html 里的全部 section、弹窗和全局交互。
 * 理解页面问题时，建议按下面顺序排查：
 * 1. DOMContentLoaded 初始化链是否执行；
 * 2. switchPage 是否切到目标页面；
 * 3. 对应 loadXxx / renderXxx / showXxx 函数是否被调用；
 * 4. pywebview.api.* 是否成功返回数据；
 * 5. 最终结果是否写回 index.html 预留的容器或表单控件。
 *
 * 真实主链：index.html 结构挂载点 -> app.js 状态/事件/渲染 -> pywebview.api -> api.py -> BookkeepingService。
 */

// ===== 状态管理 =====
// 这里集中存放前端运行期状态；页面之间不会重新创建实例，而是共享这一份内存状态。
// 运行时状态中心：几乎所有页面渲染都依赖这里的缓存和当前上下文。
// 如果页面显示不对，优先看对应状态字段是否已被 load* 函数填充。
const state = {
    // 分类既保留树形结构（用于记一笔页面），也保留扁平结构（用于编辑弹窗、管理页等 select）。
    categories: { expense: [], income: [] },
    flatCategories: { expense: [], income: [] },
    // 当前版本 tags 虽然存在状态缓存，但 UI 使用较轻，主要服务于记录扩展能力。
    tags: [],
    records: [],
    accounts: [],
    budgets: [],
    ledgers: [],
    // 侧边栏账本切换器和账本管理页会共同维护这个当前账本上下文。
    currentLedgerId: '',
    // 当前显示中的主页面，对账本切换后的局部刷新逻辑有影响。
    currentPage: 'dashboard',
    // “记一笔”页的当前收支类型与分类选择状态。
    addType: 'expense',
    selectedCategory: null,
    selectedSubCategory: null,
    selectedTags: [],
    // 编辑记录弹窗会用到的独立编辑类型状态。
    editType: 'expense',
    // 统计页当前周期：week / month / year。
    statsPeriod: 'week',
    // 图表RAF管理（防止内存泄漏）
    chartRAF: {
        weekChart: null,
        trendChart: null,
        pieChart: null,
        assetChart: null
    },
    // 请求防抖管理
    pendingRequests: new Set()
};

// ===== 工具函数 =====
// 这一组函数负责 DOM 拼接时的转义、安全颜色处理和图表渲染清理，避免 XSS、非法样式和重复 RAF。
// 这一组工具主要做两件事：
// 1) 把后端返回的数据安全写入 HTML/属性/onclick；
// 2) 避免图表和样式类场景因为原始值异常导致前端炸掉。
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// 用于 HTML 属性值（会被浏览器解码为原始字符）
function escapeAttr(text) {
    return escapeHtml(text).replace(/`/g, '&#096;');
}

// 用于内联 onclick 的单引号字符串参数：onclick="fn('...')"
function escapeJsString(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}

// 颜色值尽量限制为常见 Hex（避免 style 属性被注入复杂内容）；不满足则回退
function safeCssHexColor(color, fallback = '#eee') {
    const raw = String(color ?? '').trim();
    if (/^#[0-9a-fA-F]{3}$/.test(raw)) return raw;
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
    if (/^#[0-9a-fA-F]{8}$/.test(raw)) return raw;
    return fallback;
}

// 取消所有待执行的图表渲染
function cancelPendingChartRAF() {
    Object.keys(state.chartRAF).forEach(key => {
        if (state.chartRAF[key]) {
            cancelAnimationFrame(state.chartRAF[key]);
            state.chartRAF[key] = null;
        }
    });
}

// ===== 初始化 =====
// 这是前端的真实总入口：必须等 pywebview 注入 API 之后，才能开始绑定事件和首屏加载。
// 页面初始化总入口：等待 pywebview 注入 API 后，再依次绑定导航/主题/表单/筛选器，最后拉取首屏数据。
document.addEventListener('DOMContentLoaded', async () => {
    await waitForApi();
    // 先绑定交互，再加载数据，避免用户点击时函数还没挂好。
    initNavigation();
    initTheme();
    initAddForm();
    initFilters();
    initStatsTabs();
    initLedgerSwitcher();
    setDefaultDates();
    await loadInitialData();
    updateGreeting();
    initCatInteraction();
});

// ===== 🐱 猫咪互动 =====
// 纯 UI 点缀，不参与业务链路；排查业务问题时通常可以忽略这里。
function initCatInteraction() {
    const catFace = document.querySelector('.cat-face');
    const eyes = document.querySelectorAll('.cat-eye');
    if (!catFace || eyes.length === 0) return;

    document.addEventListener('mousemove', (e) => {
        const rect = catFace.getBoundingClientRect();
        const catX = rect.left + rect.width / 2;
        const catY = rect.top + rect.height / 2;

        const angle = Math.atan2(e.clientY - catY, e.clientX - catX);
        const distance = Math.min(2, Math.hypot(e.clientX - catX, e.clientY - catY) / 50);

        const x = Math.cos(angle) * distance;
        const y = Math.sin(angle) * distance;

        eyes.forEach(eye => {
            eye.style.transform = `translate(${x}px, ${y}px)`;
        });
    });
}

// ===== 主题系统 =====
// 主题属于全局配置：初始化时读取，切换时即时写回后端 config.json 与浏览器 localStorage。
const THEME_ICONS = {
    'light': '☀️', 'cute': '🐱', 'office': '📊',
    'neon-light': '🌊', 'cyberpunk-light': '🌸',
    'dark': '🌙', 'neon': '🌃', 'cyberpunk': '🤖'
};

async function initTheme() {
    // 这里优先以后端保存值为准，保证打包态 / 本地态都能复用同一份主题配置。
    // 优先从后端获取主题，回退到 localStorage
    let savedTheme = 'cute';
    try {
        savedTheme = await pywebview.api.get_theme();
    } catch (e) {
        savedTheme = localStorage.getItem('theme') || 'cute';
    }
    setTheme(savedTheme, false);

    // 点击外部关闭菜单
    window.addEventListener('click', (e) => {
        const menu = document.getElementById('themeMenu');
        const btn = document.getElementById('themeToggleBtn');
        if (menu && btn && menu.classList.contains('active')) {
            if (!menu.contains(e.target) && !btn.contains(e.target)) {
                menu.classList.remove('active');
            }
        }
    });
}

function toggleThemeMenu() {
    const menu = document.getElementById('themeMenu');
    menu.classList.toggle('active');
}

function selectTheme(theme) {
    setTheme(theme);
    document.getElementById('themeMenu').classList.remove('active');
}

function setTheme(theme, save = true) {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    updateThemeIcon(theme);
    updateThemeSelector(theme);
    // 保存到后端
    if (save) {
        pywebview.api.save_theme(theme).catch(() => {});
    }
}

function updateThemeIcon(theme) {
    const iconEl = document.getElementById('currentThemeIcon');
    if (iconEl && THEME_ICONS[theme]) {
        iconEl.textContent = THEME_ICONS[theme];
    }
}

function updateThemeSelector(activeTheme) {
    document.querySelectorAll('.theme-item').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.theme === activeTheme);
    });
}

// 等待桌面壳注入 pywebview.api。若这里卡住，通常说明 main.py / pywebview 窗口初始化链有问题。
async function waitForApi() {
    // pywebview 在窗口建立后才会注入 window.pywebview.api；这里轮询等待，避免首屏调用过早。
    while (!window.pywebview?.api) {
        await new Promise(r => setTimeout(r, 50));
    }
}

// 首屏基础数据加载：先把分类、标签、账户、账本缓存进 state，再刷新首页。
async function loadInitialData() {
    // 首屏缓存加载：分类、标签、账户、账本可并行获取，首页刷新依赖它们完成后再执行。
    await Promise.all([
        loadCategories(),
        loadTags(),
        loadAccounts(),
        loadLedgers(),
    ]);
    await refreshDashboard();
}

// ===== 导航 =====
// 单页应用不做路由跳转，所有页面切换都在同一个 HTML 里通过 class 切换完成。
// 侧边栏导航与 HTML 中 data-page 一一对应，switchPage 是整个单页应用的页面路由中枢。
// 绑定左侧导航点击事件：把 data-page 分发给 switchPage。
function initNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page;
            switchPage(page);
        });
    });
}

// 页面切换分发器：负责 section 显隐、导航高亮，以及触发目标页面的 load/render 初始化。
function switchPage(page) {
    // 页面切换的真实入口：
    // 1) 更新侧边栏 active
    // 2) 切换对应 section
    // 3) 根据目标页执行对应的数据加载/渲染函数
    // 切页前取消图表 RAF，避免后台占用或重复渲染
    cancelPendingChartRAF();

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`)?.classList.add('active');

    state.currentPage = page;

    if (page === 'dashboard') refreshDashboard();
    else if (page === 'add') renderAddForm();
    else if (page === 'records') loadRecords();
    else if (page === 'stats') loadStats();
    else if (page === 'accounts') loadAccountsPage();
    else if (page === 'budgets') loadBudgetsPage();
    else if (page === 'ledgers') loadLedgersPage();
    else if (page === 'categories') renderCategoryManagement();
    else if (page === 'backup') initBackupPage();
}

// ===== 账本切换 =====
// 账本是全局筛选上下文。切换后，首页与部分业务数据都会基于 currentLedgerId 重新拉取。
// 账本切换是跨页面的全局过滤器；首页、账单、统计、预算等都会受 currentLedgerId 影响。
function initLedgerSwitcher() {
    document.getElementById('current-ledger').addEventListener('change', async (e) => {
        state.currentLedgerId = e.target.value;
        await refreshDashboard();
    });
}

// 预加载账本数据并更新左侧下拉框。
async function loadLedgers() {
    // 供两个地方复用：侧边栏下拉框和账本管理页都会读取 state.ledgers。
    state.ledgers = await pywebview.api.get_ledgers();
    renderLedgerSelect();
}

function renderLedgerSelect() {
    const select = document.getElementById('current-ledger');
    select.innerHTML = state.ledgers.map(l =>
        `<option value="${escapeAttr(l.id)}" ${l.is_default ? 'selected' : ''}>${escapeHtml(l.icon)} ${escapeHtml(l.name)}</option>`
    ).join('');
    state.currentLedgerId = select.value;
}

// ===== 问候语 =====
// 首页顶部的“早上好/下午好”属于纯前端时间文案，不依赖后端。
function updateGreeting() {
    const hour = new Date().getHours();
    let greeting = '早上好！';
    let tip = '新的一天，记得记录开销喵～';

    if (hour >= 11 && hour < 14) {
        greeting = '中午好！';
        tip = '午饭吃了吗？记得记录喵～';
    } else if (hour >= 14 && hour < 18) {
        greeting = '下午好！';
        tip = '下午茶时间，小心钱包喵～';
    } else if (hour >= 18 && hour < 22) {
        greeting = '晚上好！';
        tip = '今天花了多少呢？';
    } else if (hour >= 22 || hour < 6) {
        greeting = '夜深了！';
        tip = '早点休息喵～';
    }

    document.getElementById('greeting-text').textContent = greeting;
    document.getElementById('cat-tip').textContent = tip;
}

// ===== 数据加载 =====
// 这些 load* 负责把后端基础主数据拉进 state，后续各页面渲染直接消费缓存。
// 这里是多个页面共享的基础缓存加载层；排查“下拉为空/分类不显示”时先看这里。
// 同时加载树形分类和扁平分类：前者给页面展示，后者给编辑/下拉选择使用。
async function loadCategories() {
    const [expense, income] = await Promise.all([
        pywebview.api.get_categories('expense'),
        pywebview.api.get_categories('income')
    ]);
    state.categories.expense = expense;
    state.categories.income = income;

    const [flatExpense, flatIncome] = await Promise.all([
        pywebview.api.get_flat_categories('expense'),
        pywebview.api.get_flat_categories('income')
    ]);
    state.flatCategories.expense = flatExpense;
    state.flatCategories.income = flatIncome;
}

async function loadTags() {
    state.tags = await pywebview.api.get_tags();
}

// 加载账户列表并同步刷新“记一笔”页面的账户下拉。
async function loadAccounts() {
    state.accounts = await pywebview.api.get_accounts();
    renderAccountSelect();
}

function renderAccountSelect() {
    // 记一笔页面的账户下拉只负责简单渲染；账户卡片页另有独立的 renderAccountsGrid。
    const select = document.getElementById('input-account');
    if (select) {
        select.innerHTML = state.accounts.map(a =>
            `<option value="${escapeAttr(a.id)}" ${a.is_default ? 'selected' : ''}>${escapeHtml(a.icon)} ${escapeHtml(a.name)}</option>`
        ).join('');
    }
}

// ===== 首页 =====
// 首页是总览页，数据来源最杂：月度汇总、周统计、最近记录、总资产、预算状态会并行请求。
// 首页是一个聚合页：一次 refreshDashboard 会并行拉多个接口，再分发到不同板块。
// 首页刷新主入口：通常在首屏加载、切回首页、切换账本后触发。
async function refreshDashboard() {
    const ledgerId = state.currentLedgerId;
    // 页面 -> JS -> API 主链：
    // 首页刷新 -> refreshDashboard -> get_month_summary/get_weekly_stats/get_records/get_total_assets/get_budget_status
    const [monthSummary, weekStats, recentRecords, assets, budgetStatus] = await Promise.all([
        pywebview.api.get_month_summary(ledgerId),
        pywebview.api.get_weekly_stats('', ledgerId),
        pywebview.api.get_records('', '', '', '', '', ledgerId, 5),
        pywebview.api.get_total_assets(),
        pywebview.api.get_budget_status(ledgerId),
    ]);

    // 资产概览
    document.getElementById('total-assets').textContent = `¥${assets.total_assets.toFixed(2)}`;
    document.getElementById('total-debt').textContent = `¥${assets.credit_debt.toFixed(2)}`;
    document.getElementById('net-assets').textContent = `¥${assets.net_assets.toFixed(2)}`;

    // 月度汇总
    document.getElementById('month-income').textContent = `¥${monthSummary.total_income.toFixed(2)}`;
    document.getElementById('month-expense').textContent = `¥${monthSummary.total_expense.toFixed(2)}`;
    const balanceEl = document.getElementById('month-balance');
    balanceEl.textContent = `¥${monthSummary.balance.toFixed(2)}`;
    balanceEl.className = 'card-amount ' + (monthSummary.balance >= 0 ? 'positive' : 'negative');

    // 预算预警
    renderBudgetAlerts(budgetStatus);

    // 周趋势图
    drawWeekChart(weekStats);

    // 最近记录
    renderRecentRecords(recentRecords);
}

// 渲染预算预警卡片；如果这里为空，检查 get_budget_status 是否返回了 is_warning / is_over 预算。
function renderBudgetAlerts(budgets) {
    // 首页预算条只显示“预警/超支”项，普通预算不会在这里出现。
    const container = document.getElementById('budget-alerts');
    const alerts = budgets.filter(b => b.is_warning || b.is_over);

    if (!alerts.length) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = alerts.map(b => `
        <div class="budget-alert ${b.is_over ? 'danger' : ''}">
            <span class="alert-icon">${b.is_over ? '🚨' : '⚠️'}</span>
            <span class="alert-text">${escapeHtml(b.name)} 预算${b.is_over ? '已超支' : '即将用完'}！</span>
            <span class="alert-amount">已用 ${b.percentage}%</span>
        </div>
    `).join('');
}

// 首页最近记录区渲染：这里只展示少量最新记录，完整列表请看 loadRecords -> renderRecordsList。
function renderRecentRecords(records) {
    // 首页最近记录是轻量预览区，不做分页，只展示最新 5 条。
    const container = document.getElementById('recent-records');
    if (!records.length) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="empty-cat">😴</span>
                <p>还没有记录喵～</p>
                <button class="btn btn-primary btn-sm" onclick="switchPage('add')">记一笔</button>
            </div>`;
        return;
    }

    container.innerHTML = records.map(r => `
        <div class="record-item" onclick="showEditModal('${escapeJsString(r.id)}')">
            <div class="record-icon" style="background:${escapeAttr(safeCssHexColor(r.category?.color, '#eee'))}">
                ${escapeHtml(r.category?.icon || '📦')}
            </div>
            <div class="record-info">
                <span class="record-category">${escapeHtml(r.category?.name) || '未知'}</span>
                <span class="record-meta">${escapeHtml(r.date)} ${r.note ? '· ' + escapeHtml(r.note) : ''}</span>
            </div>
            <span class="record-amount ${r.type === 'income' ? 'positive' : 'negative'}">
                ${r.type === 'income' ? '+' : '-'}¥${r.amount.toFixed(2)}
            </span>
        </div>
    `).join('');
}

// ===== 周趋势图 =====
// 图表绘制与数据获取解耦：refreshDashboard 只拿数据，drawWeekChart 系列只负责画布渲染。
// 图表调度层：先取消旧 RAF，再异步安排本周趋势图绘制，避免页面切换时叠加渲染。
function drawWeekChart(data) {
    const canvas = document.getElementById('week-chart');
    if (!canvas) return;

    // 取消之前的渲染请求
    if (state.chartRAF.weekChart) {
        cancelAnimationFrame(state.chartRAF.weekChart);
    }

    // 使用RAF优化渲染
    state.chartRAF.weekChart = requestAnimationFrame(() => {
        drawWeekChartImpl(canvas, data);
        state.chartRAF.weekChart = null;
    });
}

function drawWeekChartImpl(canvas, data) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const padding = { top: 20, right: 20, bottom: 30, left: 10 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    ctx.clearRect(0, 0, width, height);
    if (!data.length) return;

    const maxVal = Math.max(...data.map(d => Math.max(d.income, d.expense)), 100);
    const barWidth = chartWidth / data.length * 0.6;
    const gap = chartWidth / data.length;

    data.forEach((d, i) => {
        const x = padding.left + i * gap + gap / 2;

        const expenseH = (d.expense / maxVal) * chartHeight;
        ctx.fillStyle = '#FFB7B2';
        ctx.beginPath();
        roundRect(ctx, x - barWidth / 2, padding.top + chartHeight - expenseH, barWidth / 2 - 2, expenseH, 4);
        ctx.fill();

        const incomeH = (d.income / maxVal) * chartHeight;
        ctx.fillStyle = '#B5EAD7';
        ctx.beginPath();
        roundRect(ctx, x + 2, padding.top + chartHeight - incomeH, barWidth / 2 - 2, incomeH, 4);
        ctx.fill();

        ctx.fillStyle = '#888';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        const dayLabel = ['日', '一', '二', '三', '四', '五', '六'][new Date(d.date).getDay()];
        ctx.fillText(dayLabel, x, height - 8);
    });
}

function roundRect(ctx, x, y, w, h, r) {
    if (h < r * 2) r = h / 2;
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
}

// ===== 记一笔 =====
// 这里是新增记录的完整交互链：按钮切换 -> renderAddForm -> 用户输入 -> saveRecord -> pywebview.api.add_record。
// 这是录入主链：renderAddForm 负责填充界面，saveRecord 负责调用 add_record 真正落盘。
// 绑定“记一笔”页的核心交互：收支类型按钮与保存按钮。
function initAddForm() {
    document.querySelectorAll('.add-form .type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.add-form .type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.addType = btn.dataset.type;
            state.selectedCategory = null;
            state.selectedSubCategory = null;
            state.selectedTags = [];
            renderAddForm();
        });
    });

    document.getElementById('btn-save').addEventListener('click', saveRecord);
}

function setDefaultDates() {
    const today = new Date();
    document.getElementById('input-date').value = today.toISOString().split('T')[0];

    const monthInput = document.getElementById('filter-month');
    monthInput.value = today.toISOString().slice(0, 7);
}

// 根据当前 state.addType / selectedCategory / selectedTags 重建录入区的可选内容与按钮状态。
async function renderAddForm() {
    // 这个函数每次切换收支类型、应用推荐、或进入记一笔页时都会重跑，用于把页面恢复到“当前状态”。
    // 确保分类数据已加载
    if (!state.categories.expense.length && !state.categories.income.length) {
        await loadCategories();
    }

    // 智能推荐
    const suggestions = await pywebview.api.get_smart_suggestions();
    renderSmartSuggestions(suggestions);

    // 分类（父级）
    const cats = state.categories[state.addType];
    const grid = document.getElementById('category-grid');
    grid.innerHTML = cats.map(c => `
        <div class="category-item ${state.selectedCategory === c.id ? 'selected' : ''}"
             data-id="${escapeAttr(c.id)}" onclick="selectCategory('${escapeJsString(c.id)}')">
            <div class="category-icon" style="background:${escapeAttr(safeCssHexColor(c.color, '#eee'))}">${escapeHtml(c.icon)}</div>
            <span class="category-name">${escapeHtml(c.name)}</span>
        </div>
    `).join('');

    // 子分类
    renderSubcategories();

    // 账户选择
    renderAccountSelect();
}

function renderSmartSuggestions(suggestions) {
    // 推荐卡片只做快捷回填，不会直接提交记录。
    const container = document.getElementById('smart-suggestions');
    if (!suggestions.length) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = suggestions.map(s => `
        <div class="suggestion-item" onclick="applySuggestion('${escapeJsString(s.category_id)}', ${Number(s.suggested_amount) || 0})">
            <div class="suggestion-icon" style="background:var(--pink-light)">${escapeHtml(s.category_icon)}</div>
            <div class="suggestion-info">
                <div>${escapeHtml(s.category_name)}</div>
                ${s.suggested_amount ? `<div class="suggestion-amount">¥${s.suggested_amount}</div>` : ''}
            </div>
        </div>
    `).join('');
}

function applySuggestion(categoryId, amount) {
    // 应用推荐后仍需用户手动确认日期/备注并点击保存。
    state.selectedCategory = categoryId;
    state.selectedSubCategory = null;
    if (amount > 0) {
        document.getElementById('input-amount').value = amount;
    }
    renderAddForm();
}

function renderSubcategories() {
    // 子分类区是一级分类的附属动态区域，没有父分类时直接隐藏为空。
    const subGrid = document.getElementById('subcategory-grid');
    if (!state.selectedCategory) {
        subGrid.innerHTML = '';
        return;
    }

    const parent = state.categories[state.addType].find(c => c.id === state.selectedCategory);
    if (!parent?.children?.length) {
        subGrid.innerHTML = '';
        return;
    }

    subGrid.innerHTML = parent.children.map(c => `
        <div class="subcategory-item ${state.selectedSubCategory === c.id ? 'selected' : ''}"
             onclick="selectSubCategory('${escapeJsString(c.id)}')">
            <span>${escapeHtml(c.icon)}</span>
            <span>${escapeHtml(c.name)}</span>
        </div>
    `).join('');
}

function selectCategory(id) {
    state.selectedCategory = id;
    state.selectedSubCategory = null;
    state.selectedTags = [];
    renderSubcategories();
    document.querySelectorAll('.category-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.id === id);
    });
}

function selectSubCategory(id) {
    state.selectedSubCategory = id;
    document.querySelectorAll('.subcategory-item').forEach(el => {
        el.classList.toggle('selected', el.textContent.includes(state.flatCategories[state.addType].find(c => c.id === id)?.name));
    });
    renderSubcategories();
}

let isSavingRecord = false;
// 新增记录提交入口：先做前端必填校验，再调用后端 add_record，并在成功后刷新首页/账单/统计相关状态。
async function saveRecord() {
    // “记一笔”页提交主链：
    // 读取表单 -> 前端最小校验 -> pywebview.api.add_record -> 成功后清空表单并重绘页面。
    if (isSavingRecord) return;

    const amount = parseFloat(document.getElementById('input-amount').value);
    const date = document.getElementById('input-date').value;
    const note = document.getElementById('input-note').value;
    const accountId = document.getElementById('input-account').value;

    if (!amount || amount <= 0) {
        showToast('请输入金额喵～', true);
        return;
    }

    const categoryId = state.selectedSubCategory || state.selectedCategory;
    if (!categoryId) {
        showToast('请选择分类喵～', true);
        return;
    }

    isSavingRecord = true;
    try {
        const result = await pywebview.api.add_record(
            state.addType, amount, categoryId,
            date, '', note, state.selectedTags,
            accountId, state.currentLedgerId
        );

        // 检查 API 返回的错误
        if (result && result.success === false) {
            showToast(result.error || '保存失败', true);
            return;
        }

        // 检查预算警告
        if (result.has_budget_warning && result.budget_warnings?.length > 0) {
            showBudgetWarningModal(result.budget_warnings);
        }

        showToast('记录成功喵！');

        document.getElementById('input-amount').value = '';
        document.getElementById('input-note').value = '';
        state.selectedCategory = null;
        state.selectedSubCategory = null;
        state.selectedTags = [];
        setDefaultDates();
        renderAddForm();
    } catch (err) {
        console.error('保存失败:', err);
        showToast('保存失败: ' + err, true);
    } finally {
        isSavingRecord = false;
    }
}

// ===== 预算警告弹窗 =====
// add_record 返回 has_budget_warning=true 时会弹出；它只是提示，不会阻断前一笔记录已经保存成功。
function showBudgetWarningModal(warnings) {
    const container = document.getElementById('budget-warning-list');
    container.innerHTML = warnings.map(w => {
        const isOver = w.will_exceed;
        return `
            <div class="budget-warning-item ${isOver ? 'danger' : 'warning'}">
                <div class="budget-warning-header">
                    <span class="budget-warning-name">
                        ${isOver ? '🚨' : '⚠️'} ${escapeHtml(w.budget_name)}
                    </span>
                    <span class="budget-warning-pct">${w.pct_after}%</span>
                </div>
                <div class="budget-warning-bar">
                    <div class="budget-warning-bar-fill" style="width:${Math.min(w.pct_after, 100)}%"></div>
                </div>
                <div class="budget-warning-detail">
                    <span>已用 ¥${w.used_after.toFixed(2)} / ¥${w.amount.toFixed(2)}</span>
                    ${isOver ? `<span class="budget-warning-exceed">超支 ¥${w.exceed_by.toFixed(2)}</span>` : ''}
                </div>
            </div>
        `;
    }).join('');

    openModal('budget-warning-modal');
}

// ===== 账单列表 =====
// 账单页由“筛选条件 + 汇总条 + 日期分组列表 + 编辑弹窗”组成。
function initFilters() {
    document.getElementById('filter-type').addEventListener('change', loadRecords);
    document.getElementById('filter-month').addEventListener('change', loadRecords);
}

// 账单页数据加载：把月份选择转换成起止日期，并同时请求记录列表与区间汇总。
async function loadRecords() {
    // 账单页数据主链：
    // 筛选条件 -> get_records + get_summary -> 顶部摘要 + 列表区
    const typeFilter = document.getElementById('filter-type').value;
    const monthVal = document.getElementById('filter-month').value;

    let startDate = '', endDate = '';
    if (monthVal) {
        const [y, m] = monthVal.split('-').map(Number);
        startDate = `${y}-${String(m).padStart(2, '0')}-01`;
        const lastDay = new Date(y, m, 0).getDate();
        endDate = `${y}-${String(m).padStart(2, '0')}-${lastDay}`;
    }

    const [records, summary] = await Promise.all([
        pywebview.api.get_records(startDate, endDate, typeFilter, '', '', state.currentLedgerId, 0),
        pywebview.api.get_summary(startDate, endDate, state.currentLedgerId)
    ]);

    document.getElementById('filter-income').textContent = `¥${summary.total_income.toFixed(2)}`;
    document.getElementById('filter-expense').textContent = `¥${summary.total_expense.toFixed(2)}`;
    document.getElementById('filter-balance').textContent = `¥${summary.balance.toFixed(2)}`;

    renderRecordsList(records);
}

// 账单结果区渲染：按日期分组输出记录块，编辑按钮会进入 showEditModal。
function renderRecordsList(records) {
    // 列表按日期分组；点击任意 record-item 会继续进入 showEditModal。
    const container = document.getElementById('records-container');
    if (!records.length) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="empty-cat">📭</span>
                <p>这个月还没有记录喵～</p>
            </div>`;
        return;
    }

    const groups = {};
    records.forEach(r => {
        if (!groups[r.date]) groups[r.date] = [];
        groups[r.date].push(r);
    });

    container.innerHTML = Object.entries(groups).map(([date, items]) => `
        <div class="date-group">
            <div class="date-header">${formatDate(date)}</div>
            ${items.map(r => `
                <div class="record-item" onclick="showEditModal('${escapeJsString(r.id)}')">
                    <div class="record-icon" style="background:${escapeAttr(safeCssHexColor(r.category?.color, '#eee'))}">
                        ${escapeHtml(r.category?.icon || '📦')}
                    </div>
                    <div class="record-info">
                        <span class="record-category">${escapeHtml(r.category?.name) || '未知'}</span>
                        <span class="record-meta">${escapeHtml(r.time || '')} ${r.account?.name ? '· ' + escapeHtml(r.account.icon || '') + escapeHtml(r.account.name) : ''} ${r.note ? '· ' + escapeHtml(r.note) : ''}</span>
                    </div>
                    <span class="record-amount ${r.type === 'income' ? 'positive' : 'negative'}">
                        ${r.type === 'income' ? '+' : '-'}¥${r.amount.toFixed(2)}
                    </span>
                </div>
            `).join('')}
        </div>
    `).join('');
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (dateStr === today.toISOString().split('T')[0]) return '今天';
    if (dateStr === yesterday.toISOString().split('T')[0]) return '昨天';

    const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${d.getMonth() + 1}月${d.getDate()}日 ${weekDays[d.getDay()]}`;
}

// ===== 编辑弹窗 =====
// 这里处理账单页的编辑/删除流，属于“已有记录”的二次操作入口。
// 当前实现中，编辑弹窗兼顾“查看、修改、删除单条记录”三种动作。
let currentEditRecord = null;

// 打开编辑记录弹窗：先从后端重新拉全量记录并定位目标记录，再回填弹窗表单。
async function showEditModal(id) {
    // 这里通过 get_records 全量取回后在前端定位目标记录，用于回填弹窗表单。
    const records = await pywebview.api.get_records('', '', '', '', '', '', 0);
    currentEditRecord = records.find(r => r.id === id);
    if (!currentEditRecord) return;

    document.getElementById('edit-id').value = id;
    document.getElementById('edit-amount').value = currentEditRecord.amount;
    document.getElementById('edit-date').value = currentEditRecord.date;
    document.getElementById('edit-time').value = currentEditRecord.time || '';
    document.getElementById('edit-note').value = currentEditRecord.note || '';

    state.editType = currentEditRecord.type;
    updateEditTypeButtons();
    updateEditCategorySelect();
    updateEditAccountSelect();

    openModal('edit-modal');
}

function updateEditTypeButtons() {
    document.getElementById('edit-type-expense').classList.toggle('active', state.editType === 'expense');
    document.getElementById('edit-type-income').classList.toggle('active', state.editType === 'income');

    document.querySelectorAll('#edit-modal .type-btn').forEach(btn => {
        btn.onclick = () => {
            state.editType = btn.dataset.type;
            updateEditTypeButtons();
            updateEditCategorySelect();
        };
    });
}

function updateEditCategorySelect() {
    const select = document.getElementById('edit-category');
    const cats = state.flatCategories[state.editType];
    select.innerHTML = cats.map(c =>
        `<option value="${escapeAttr(c.id)}" ${c.id === currentEditRecord?.category_id ? 'selected' : ''}>${escapeHtml(c.icon)} ${escapeHtml(c.name)}</option>`
    ).join('');
}

function updateEditAccountSelect() {
    const select = document.getElementById('edit-account');
    select.innerHTML = state.accounts.map(a =>
        `<option value="${escapeAttr(a.id)}" ${a.id === currentEditRecord?.account_id ? 'selected' : ''}>${escapeHtml(a.icon)} ${escapeHtml(a.name)}</option>`
    ).join('');
}

let isSavingEditRecord = false;
// 编辑记录保存入口：调用 update_record，成功后同步刷新首页、账单页和统计页。
async function saveEditRecord() {
    // 保存编辑主链：表单 -> update_record -> 成功后关闭弹窗并刷新账单/首页。
    if (isSavingEditRecord) return;

    const id = document.getElementById('edit-id').value;
    const amount = parseFloat(document.getElementById('edit-amount').value);
    const categoryId = document.getElementById('edit-category').value;
    const accountId = document.getElementById('edit-account').value;
    const date = document.getElementById('edit-date').value;
    const time = document.getElementById('edit-time').value;
    const note = document.getElementById('edit-note').value;

    if (!amount || amount <= 0) {
        showToast('请输入有效金额', true);
        return;
    }

    isSavingEditRecord = true;
    try {
        const result = await pywebview.api.update_record(id, state.editType, amount, categoryId, date, time, note, [], accountId, currentEditRecord.ledger_id);

        if (result && result.success === false) {
            showToast(result.error || '修改失败', true);
            return;
        }

        showToast('修改成功喵！');
        closeModal('edit-modal');
        loadRecords();
        refreshDashboard();
    } catch (err) {
        console.error('修改失败:', err);
        showToast('修改失败: ' + err, true);
    } finally {
        isSavingEditRecord = false;
    }
}

// 删除当前编辑中的记录：走后端 delete_record，再关闭弹窗并刷新相关页面。
async function deleteCurrentRecord() {
    // 删除后需要同时刷新账单页和首页，因为两边都展示记录/余额相关信息。
    const id = document.getElementById('edit-id').value;
    if (!confirm('确定要删除这条记录吗？')) return;

    await pywebview.api.delete_record(id);
    showToast('已删除');
    closeModal('edit-modal');
    loadRecords();
    refreshDashboard();
}

// ===== 统计 =====
// 统计页负责把后端返回的数值结果转成多个图表和排行列表。
// 统计页不是单一接口，而是按当前周期组合汇总、趋势、分类占比和资产趋势四类数据。
function initStatsTabs() {
    document.querySelectorAll('.stats-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.stats-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            state.statsPeriod = tab.dataset.period;
            loadStats();
        });
    });
}

// 统计页主入口：根据当前周期计算时间范围，再并行拉取 summary / daily / category / asset 数据。
async function loadStats() {
    // 统计页主链：
    // 当前周期 -> 推导 start/end -> get_summary + get_daily_stats/get_monthly_stats + get_category_stats + get_asset_trend
    const today = new Date();
    let startDate, endDate;

    if (state.statsPeriod === 'week') {
        const monday = new Date(today);
        monday.setDate(today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1));
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        startDate = monday.toISOString().split('T')[0];
        endDate = sunday.toISOString().split('T')[0];
    } else if (state.statsPeriod === 'month') {
        startDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
        endDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
    } else {
        startDate = `${today.getFullYear()}-01-01`;
        endDate = `${today.getFullYear()}-12-31`;
    }

    const ledgerId = state.currentLedgerId;
    const [summary, dailyStats, categoryStats, assetTrend] = await Promise.all([
        pywebview.api.get_summary(startDate, endDate, ledgerId),
        state.statsPeriod === 'year'
            ? pywebview.api.get_monthly_stats(today.getFullYear(), ledgerId)
            : pywebview.api.get_daily_stats(startDate, endDate, ledgerId),
        pywebview.api.get_category_stats(startDate, endDate, 'expense', ledgerId),
        pywebview.api.get_asset_trend(6)
    ]);

    document.getElementById('stats-income').textContent = `¥${summary.total_income.toFixed(2)}`;
    document.getElementById('stats-expense').textContent = `¥${summary.total_expense.toFixed(2)}`;
    const balanceEl = document.getElementById('stats-balance');
    balanceEl.textContent = `¥${summary.balance.toFixed(2)}`;
    balanceEl.className = 'stat-value ' + (summary.balance >= 0 ? 'positive' : 'negative');

    drawTrendChart(dailyStats);
    drawPieChart(categoryStats);
    renderCategoryRanking(categoryStats);
    drawAssetChart(assetTrend);
}

// 收支趋势图调度层：负责 RAF 节流与实际绘图入口调用。
function drawTrendChart(data) {
    // 趋势图与首页周图类似，依旧采用 RAF，避免频繁切页时 canvas 重绘堆积。
    const canvas = document.getElementById('trend-chart');
    if (!canvas) return;

    // 取消之前的渲染请求
    if (state.chartRAF.trendChart) {
        cancelAnimationFrame(state.chartRAF.trendChart);
    }

    // 使用RAF优化渲染
    state.chartRAF.trendChart = requestAnimationFrame(() => {
        drawTrendChartImpl(canvas, data);
        state.chartRAF.trendChart = null;
    });
}

function drawTrendChartImpl(canvas, data) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const padding = { top: 20, right: 20, bottom: 35, left: 50 };

    ctx.clearRect(0, 0, width, height);
    if (!data.length) return;

    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const labels = data.map(d => d.month_label || d.date.slice(5));
    const maxVal = Math.max(...data.map(d => Math.max(d.income, d.expense)), 100);

    const stepX = chartWidth / (data.length - 1 || 1);

    ctx.strokeStyle = '#f0f0f0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding.top + (chartHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
    }

    ctx.strokeStyle = '#FFB7B2';
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((d, i) => {
        const x = padding.left + i * stepX;
        const y = padding.top + chartHeight - (d.expense / maxVal) * chartHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.strokeStyle = '#B5EAD7';
    ctx.beginPath();
    data.forEach((d, i) => {
        const x = padding.left + i * stepX;
        const y = padding.top + chartHeight - (d.income / maxVal) * chartHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#888';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';

    const labelStep = data.length > 15 ? Math.ceil(data.length / 10) : 1;
    data.forEach((d, i) => {
        if (i % labelStep === 0) {
            const x = padding.left + i * stepX;
            ctx.fillText(labels[i], x, height - 8);
        }
    });
}

// 支出分布图调度层：负责调用饼图绘制和图例同步。
function drawPieChart(data) {
    // 饼图除了画布本身，还会同步维护旁边的图例 legend。
    const canvas = document.getElementById('pie-chart');
    if (!canvas) return;

    // 取消之前的渲染请求
    if (state.chartRAF.pieChart) {
        cancelAnimationFrame(state.chartRAF.pieChart);
    }

    // 使用RAF优化渲染
    state.chartRAF.pieChart = requestAnimationFrame(() => {
        drawPieChartImpl(canvas, data);
        state.chartRAF.pieChart = null;
    });
}

function drawPieChartImpl(canvas, data) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.parentElement.getBoundingClientRect();
    const size = Math.min(rect.width, 160);
    canvas.width = Math.floor(size * dpr);
    canvas.height = Math.floor(size * dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, size, size);

    if (!data.length) {
        ctx.fillStyle = '#eee';
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2 - 10, 0, Math.PI * 2);
        ctx.fill();
        return;
    }

    const total = data.reduce((sum, d) => sum + d.amount, 0);
    const cx = size / 2, cy = size / 2, r = size / 2 - 10;
    let startAngle = -Math.PI / 2;

    data.forEach(d => {
        const sliceAngle = (d.amount / total) * Math.PI * 2;
        ctx.fillStyle = d.category_color;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, startAngle, startAngle + sliceAngle);
        ctx.closePath();
        ctx.fill();
        startAngle += sliceAngle;
    });

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.fill();

    const legend = document.getElementById('pie-legend');
    if (legend) {
        legend.innerHTML = data.slice(0, 5).map(d => `
            <span class="legend-item">
                <span class="legend-dot" style="background:${escapeAttr(safeCssHexColor(d.category_color, '#eee'))}"></span>
                ${escapeHtml(d.category_name)}
            </span>
        `).join('');
    }
}

// 资产趋势图调度层：页面切换频繁时靠 RAF 管理避免重复重绘。
function drawAssetChart(data) {
    // 资产趋势图展示的是最近几个月总资产变化，不受当前统计周期切换影响。
    const canvas = document.getElementById('asset-chart');
    if (!canvas) return;

    // 取消之前的渲染请求
    if (state.chartRAF.assetChart) {
        cancelAnimationFrame(state.chartRAF.assetChart);
    }

    // 使用RAF优化渲染
    state.chartRAF.assetChart = requestAnimationFrame(() => {
        drawAssetChartImpl(canvas, data);
        state.chartRAF.assetChart = null;
    });
}

function drawAssetChartImpl(canvas, data) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const padding = { top: 20, right: 20, bottom: 35, left: 60 };

    ctx.clearRect(0, 0, width, height);
    if (!data.length) return;

    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const maxVal = Math.max(...data.map(d => d.assets), 100);
    const minVal = Math.min(...data.map(d => d.assets), 0);
    const range = maxVal - minVal || 1;

    const stepX = chartWidth / (data.length - 1 || 1);

    // 绘制渐变区域
    const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
    gradient.addColorStop(0, 'rgba(181, 234, 215, 0.3)');
    gradient.addColorStop(1, 'rgba(181, 234, 215, 0)');

    ctx.beginPath();
    ctx.moveTo(padding.left, height - padding.bottom);
    data.forEach((d, i) => {
        const x = padding.left + i * stepX;
        const y = padding.top + chartHeight - ((d.assets - minVal) / range) * chartHeight;
        ctx.lineTo(x, y);
    });
    ctx.lineTo(padding.left + (data.length - 1) * stepX, height - padding.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 绘制折线
    ctx.strokeStyle = '#52B788';
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((d, i) => {
        const x = padding.left + i * stepX;
        const y = padding.top + chartHeight - ((d.assets - minVal) / range) * chartHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 绘制数据点
    data.forEach((d, i) => {
        const x = padding.left + i * stepX;
        const y = padding.top + chartHeight - ((d.assets - minVal) / range) * chartHeight;
        ctx.fillStyle = '#52B788';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
    });

    // X轴标签
    ctx.fillStyle = '#888';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    data.forEach((d, i) => {
        const x = padding.left + i * stepX;
        ctx.fillText(d.month_label, x, height - 8);
    });
}

// 分类排行文本区渲染：如果统计页图正常但排行空白，优先检查这里和 get_category_stats 返回值。
function renderCategoryRanking(data) {
    // 排行区是统计页的文本结果区，便于快速确认“花钱最多的是哪类”。
    const container = document.getElementById('category-ranking');
    if (!data.length) {
        container.innerHTML = '<div class="empty-state"><p>暂无数据</p></div>';
        return;
    }

    container.innerHTML = data.slice(0, 5).map((d, i) => `
        <div class="rank-item">
            <span class="rank-num">${i + 1}</span>
            <span class="rank-icon">${escapeHtml(d.category_icon)}</span>
            <span class="rank-name">${escapeHtml(d.category_name)}</span>
            <span class="rank-amount">¥${d.amount.toFixed(2)}</span>
            <span class="rank-percent">${d.percentage}%</span>
        </div>
    `).join('');
}

// ===== 账户管理 =====
// 账户页同时承担展示、编辑、转账、对账四类操作，是账户相关问题的前端主入口。
// 账户页除了 CRUD，还承接转账、余额调整等会影响资产口径的动作。
// 账户页加载入口：刷新账户列表后，同时更新账户汇总指标与卡片网格。
async function loadAccountsPage() {
    // 页面主链：get_accounts + get_total_assets -> 顶部资产条 + 账户卡片网格
    const [accounts, assets] = await Promise.all([
        pywebview.api.get_accounts(),
        pywebview.api.get_total_assets()
    ]);
    state.accounts = accounts;

    document.getElementById('acc-total-assets').textContent = `¥${assets.total_assets.toFixed(2)}`;
    document.getElementById('acc-total-debt').textContent = `¥${assets.credit_debt.toFixed(2)}`;
    document.getElementById('acc-net-assets').textContent = `¥${assets.net_assets.toFixed(2)}`;

    renderAccountsGrid(accounts);
}

const ACCOUNT_TYPES = {
    cash: '现金',
    bank: '银行卡',
    credit: '信用卡',
    investment: '投资',
    loan: '借贷'
};

// 账户卡片网格渲染：这里会输出每张账户卡及其操作按钮。
function renderAccountsGrid(accounts) {
    // 每张卡片既是展示区，也是进入编辑弹窗的点击入口。
    const grid = document.getElementById('accounts-grid');
    grid.innerHTML = accounts.map(a => {
        let creditHtml = '';
        if (a.type === 'credit' && a.credit_limit > 0) {
            const used = Math.abs(Math.min(a.balance, 0));
            const percent = Math.min((used / a.credit_limit) * 100, 100);
            creditHtml = `
                <div class="credit-info">
                    <div class="credit-row">
                        <span>已用额度</span>
                        <span>¥${used.toFixed(2)}</span>
                    </div>
                    <div class="credit-row">
                        <span>总额度</span>
                        <span>¥${a.credit_limit.toFixed(2)}</span>
                    </div>
                    <div class="credit-bar">
                        <div class="credit-bar-fill" style="width:${percent}%"></div>
                    </div>
                </div>
            `;
        }

        return `
            <div class="account-card" data-type="${escapeAttr(a.type)}">
                <div class="account-header" onclick="showEditAccountModal('${escapeJsString(a.id)}')">
                    <div class="account-icon" style="background:${escapeAttr(safeCssHexColor(a.color, '#eee'))}">${escapeHtml(a.icon)}</div>
                    <span class="account-name">${escapeHtml(a.name)}</span>
                    <span class="account-type">${ACCOUNT_TYPES[a.type]}</span>
                </div>
                <div class="account-balance ${a.balance < 0 ? 'negative' : ''}" onclick="showEditAccountModal('${escapeJsString(a.id)}')">
                    ¥${a.balance.toFixed(2)}
                </div>
                ${a.type === 'credit' && a.billing_day ? `<div class="account-meta">账单日 ${a.billing_day}日 · 还款日 ${a.repayment_day}日</div>` : ''}
                ${creditHtml}
                ${!a.is_default ? `<button class="btn btn-ghost btn-sm account-delete-btn" onclick="event.stopPropagation();deleteAccountWithCheck('${escapeJsString(a.id)}')">删除</button>` : ''}
            </div>
        `;
    }).join('');
}

let editingAccountId = null;

// 打开新增账户弹窗，并初始化图标/颜色选择器。
function showAddAccountModal() {
    // 新增账户与编辑账户复用同一弹窗，这里负责清空为“新增模式”。
    editingAccountId = null;
    document.getElementById('account-modal-title').textContent = '添加账户';
    document.getElementById('acc-id').value = '';
    document.getElementById('acc-name').value = '';
    document.getElementById('acc-type').value = 'cash';
    document.getElementById('acc-balance').value = '0';
    document.getElementById('acc-credit-limit').value = '0';
    document.getElementById('acc-billing-day').value = '1';
    document.getElementById('acc-repayment-day').value = '15';
    toggleCreditFields();
    initAccountPickers();
    openModal('account-modal');
}

// 打开编辑账户弹窗：按账户 id 回填已有信息。
async function showEditAccountModal(id) {
    const account = state.accounts.find(a => a.id === id);
    if (!account) return;

    editingAccountId = id;
    document.getElementById('account-modal-title').textContent = '编辑账户';
    document.getElementById('acc-id').value = id;
    document.getElementById('acc-name').value = account.name;
    document.getElementById('acc-type').value = account.type;
    document.getElementById('acc-balance').value = account.balance;
    document.getElementById('acc-credit-limit').value = account.credit_limit || 0;
    document.getElementById('acc-billing-day').value = account.billing_day || 1;
    document.getElementById('acc-repayment-day').value = account.repayment_day || 15;

    toggleCreditFields();
    initAccountPickers(account.icon, account.color);
    openModal('account-modal');
}

function toggleCreditFields() {
    const type = document.getElementById('acc-type').value;
    document.getElementById('credit-fields').style.display = type === 'credit' ? 'block' : 'none';
}

let accSelectedEmoji = '💵';
let accSelectedColor = '#FFB7B2';

function initAccountPickers(emoji = '💵', color = '#FFB7B2') {
    accSelectedEmoji = emoji;
    accSelectedColor = color;

    const emojis = ['💵', '💳', '🏦', '💰', '📈', '🏠', '🚗', '💎', '🎁', '🐱'];
    document.getElementById('acc-emoji-picker').innerHTML = emojis.map(e =>
        `<span class="emoji-item ${e === accSelectedEmoji ? 'selected' : ''}" data-emoji="${e}" onclick="selectAccEmoji('${e}')">${e}</span>`
    ).join('');

    document.getElementById('acc-color-picker').innerHTML = COLOR_OPTIONS.map(c =>
        `<span class="color-item ${c === accSelectedColor ? 'selected' : ''}" style="background:${c}" data-color="${c}" onclick="selectAccColor('${c}')"></span>`
    ).join('');
}

function selectAccEmoji(emoji) {
    accSelectedEmoji = emoji;
    document.querySelectorAll('#acc-emoji-picker .emoji-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.emoji === emoji);
    });
}

function selectAccColor(color) {
    accSelectedColor = color;
    document.querySelectorAll('#acc-color-picker .color-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.color === color);
    });
}

let isSavingAccount = false;
// 账户保存入口：根据是否存在 acc-id 判断新增还是编辑，然后刷新账户相关页面缓存。
async function saveAccount() {
    // 根据 editingAccountId 判断是 add_account 还是 update_account。
    if (isSavingAccount) return;

    const name = document.getElementById('acc-name').value.trim();
    const type = document.getElementById('acc-type').value;
    const balance = parseFloat(document.getElementById('acc-balance').value) || 0;
    const creditLimit = parseFloat(document.getElementById('acc-credit-limit').value) || 0;
    const billingDay = parseInt(document.getElementById('acc-billing-day').value) || 0;
    const repaymentDay = parseInt(document.getElementById('acc-repayment-day').value) || 0;

    if (!name) {
        showToast('请输入账户名称', true);
        return;
    }

    isSavingAccount = true;
    try {
        let result;
        if (editingAccountId) {
            result = await pywebview.api.update_account(editingAccountId, name, accSelectedEmoji, accSelectedColor, balance, creditLimit, billingDay, repaymentDay, '');
        } else {
            result = await pywebview.api.add_account(name, type, accSelectedEmoji, accSelectedColor, balance, creditLimit, billingDay, repaymentDay, '');
        }

        if (result && result.success === false) {
            showToast(result.error || (editingAccountId ? '修改失败' : '添加失败'), true);
            return;
        }

        showToast(editingAccountId ? '修改成功喵！' : '添加成功喵！');
        closeModal('account-modal');
        await loadAccounts();
        loadAccountsPage();
    } finally {
        isSavingAccount = false;
    }
}

// ===== 账户转账 =====
// 转账不生成普通收支记录，只直接调用后端 transfer 调整两边账户余额。
// 打开转账弹窗：先确保账户列表已加载，再填充转出/转入下拉框。
function showTransferModal() {
    const fromSelect = document.getElementById('transfer-from');
    const toSelect = document.getElementById('transfer-to');

    // 填充账户选项
    const options = state.accounts.map(a =>
        `<option value="${escapeAttr(a.id)}">${escapeHtml(a.icon)} ${escapeHtml(a.name)} (¥${a.balance.toFixed(2)})</option>`
    ).join('');

    fromSelect.innerHTML = options;
    toSelect.innerHTML = options;

    // 默认选择不同账户
    if (state.accounts.length > 1) {
        toSelect.selectedIndex = 1;
    }

    // 清空输入
    document.getElementById('transfer-amount').value = '';
    document.getElementById('transfer-note').value = '';

    openModal('transfer-modal');
}

let isTransferring = false;
// 转账提交入口：调用 pywebview.api.transfer，成功后刷新账户页和首页汇总。
async function executeTransfer() {
    // 成功后要刷新账户页和首页，因为两边都展示资产口径。
    if (isTransferring) return;

    const fromId = document.getElementById('transfer-from').value;
    const toId = document.getElementById('transfer-to').value;
    const amount = parseFloat(document.getElementById('transfer-amount').value);
    const note = document.getElementById('transfer-note').value;

    if (!fromId || !toId) {
        showToast('请选择账户', true);
        return;
    }
    if (fromId === toId) {
        showToast('转出和转入账户不能相同喵～', true);
        return;
    }
    if (!amount || amount <= 0) {
        showToast('请输入有效金额', true);
        return;
    }

    isTransferring = true;
    try {
        const result = await pywebview.api.transfer(fromId, toId, amount, '', note);

        if (result.success) {
            showToast(`转账成功！${result.from_account.icon} → ${result.to_account.icon} ¥${result.amount.toFixed(2)}`);
            closeModal('transfer-modal');
            await loadAccounts();
            loadAccountsPage();
            refreshDashboard();
        } else {
            showToast(result.error || '转账失败', true);
        }
    } catch (err) {
        console.error('转账失败:', err);
        showToast('转账失败: ' + err, true);
    } finally {
        isTransferring = false;
    }
}

// ===== 余额调整 =====
// “对账”场景下直接把账户余额校正到目标值，而不是做一笔收入/支出记录。
// 打开对账弹窗：先回填账户列表和当前余额。
function showAdjustBalanceModal() {
    const select = document.getElementById('adjust-account');

    // 填充账户选项
    select.innerHTML = state.accounts.map(a =>
        `<option value="${escapeAttr(a.id)}" data-balance="${a.balance}">${escapeHtml(a.icon)} ${escapeHtml(a.name)}</option>`
    ).join('');

    // 更新当前余额显示
    updateCurrentBalance();

    // 清空输入
    document.getElementById('adjust-new-balance').value = '';
    document.getElementById('adjust-note').value = '';
    document.getElementById('adjust-diff').style.display = 'none';

    // 监听输入变化以显示差额
    document.getElementById('adjust-new-balance').oninput = updateBalanceDiff;

    openModal('adjust-balance-modal');
}

function updateCurrentBalance() {
    const select = document.getElementById('adjust-account');
    const selectedOption = select.options[select.selectedIndex];
    const balance = parseFloat(selectedOption?.dataset.balance || 0);
    document.getElementById('adjust-current-balance').textContent = `¥${balance.toFixed(2)}`;
    updateBalanceDiff();
}

function updateBalanceDiff() {
    const select = document.getElementById('adjust-account');
    const selectedOption = select.options[select.selectedIndex];
    const currentBalance = parseFloat(selectedOption?.dataset.balance || 0);
    const newBalance = parseFloat(document.getElementById('adjust-new-balance').value) || 0;

    const diff = newBalance - currentBalance;
    const diffEl = document.getElementById('adjust-diff');
    const diffValueEl = document.getElementById('adjust-diff-value');

    if (document.getElementById('adjust-new-balance').value) {
        diffEl.style.display = 'flex';
        const sign = diff >= 0 ? '+' : '';
        diffValueEl.textContent = `${sign}¥${diff.toFixed(2)}`;
        diffValueEl.className = 'diff-value ' + (diff >= 0 ? 'positive' : 'negative');
    } else {
        diffEl.style.display = 'none';
    }
}

let isAdjusting = false;
// 对账提交入口：调用 adjust_balance 把账户余额直接校正到目标值。
async function executeAdjustBalance() {
    // 后端返回 difference / account_name / account_icon，前端只负责展示反馈与刷新页面。
    if (isAdjusting) return;

    const accountId = document.getElementById('adjust-account').value;
    const newBalance = parseFloat(document.getElementById('adjust-new-balance').value);
    const note = document.getElementById('adjust-note').value;

    if (!accountId) {
        showToast('请选择账户', true);
        return;
    }
    if (isNaN(newBalance)) {
        showToast('请输入有效金额', true);
        return;
    }

    isAdjusting = true;
    try {
        const result = await pywebview.api.adjust_balance(accountId, newBalance, note);

        if (result.success) {
            const diffText = result.difference >= 0 ? `+¥${result.difference.toFixed(2)}` : `-¥${Math.abs(result.difference).toFixed(2)}`;
            showToast(`${result.account_icon} ${result.account_name} 余额已调整 (${diffText})`);
            closeModal('adjust-balance-modal');
            await loadAccounts();
            loadAccountsPage();
            refreshDashboard();
        } else {
            showToast(result.error || '调整失败', true);
        }
    } catch (err) {
        console.error('余额调整失败:', err);
        showToast('调整失败: ' + err, true);
    } finally {
        isAdjusting = false;
    }
}

// ===== 预算管理 =====
// 预算页以状态展示为主，新增预算走弹窗；当前“编辑预算”函数实际承担的是删除捷径。
// 预算页目前偏轻量：新增预算、查看使用情况、点击即删（暂未实现完整编辑）。
// 预算页加载入口：读取预算使用状态，而不是原始预算配置列表。
async function loadBudgetsPage() {
    const budgets = await pywebview.api.get_budget_status(state.currentLedgerId);
    state.budgets = budgets;
    renderBudgetsGrid(budgets);
}

// 预算结果区渲染：根据 is_warning / is_over 决定卡片标签和进度样式。
function renderBudgetsGrid(budgets) {
    // 预算卡片既是结果区，也是“点击删除预算”的入口。
    const container = document.getElementById('budgets-container');

    if (!budgets.length) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="empty-cat">📋</span>
                <p>还没有设置预算喵～</p>
                <button class="btn btn-primary btn-sm" onclick="showAddBudgetModal()">设置预算</button>
            </div>`;
        return;
    }

    container.innerHTML = budgets.map(b => {
        let tagClass = '';
        let tagText = '';
        if (b.is_over) {
            tagClass = 'danger';
            tagText = '已超支';
        } else if (b.is_warning) {
            tagClass = 'warning';
            tagText = '即将用完';
        }

        const cat = state.flatCategories.expense.find(c => c.id === b.category_id);

        return `
            <div class="budget-card" onclick="showEditBudgetModal('${escapeJsString(b.id)}')">
                <div class="budget-header">
                    <div class="budget-name">
                        ${cat ? `<span class="cat-icon" style="background:${escapeAttr(safeCssHexColor(cat.color, '#eee'))}">${escapeHtml(cat.icon)}</span>` : ''}
                        <span>${escapeHtml(b.name)}</span>
                    </div>
                    ${tagText ? `<span class="budget-tag ${tagClass}">${tagText}</span>` : ''}
                </div>
                <div class="budget-progress">
                    <div class="progress-bar">
                        <div class="progress-fill ${b.is_over ? 'danger' : b.is_warning ? 'warning' : ''}"
                             style="width:${Math.min(b.percentage, 100)}%"></div>
                    </div>
                </div>
                <div class="budget-stats">
                    <span class="budget-used">已用 ¥${b.used.toFixed(2)} / ¥${b.amount.toFixed(2)}</span>
                    <span class="budget-remaining ${b.remaining < 0 ? 'negative' : ''}">
                        ${b.remaining >= 0 ? '剩余' : '超支'} ¥${Math.abs(b.remaining).toFixed(2)}
                    </span>
                </div>
            </div>
        `;
    }).join('');
}

function showAddBudgetModal() {
    document.getElementById('budget-type').value = 'total';
    document.getElementById('budget-name').value = '';
    document.getElementById('budget-amount').value = '';
    toggleBudgetCategory();
    renderBudgetCategorySelect();
    openModal('budget-modal');
}

function toggleBudgetCategory() {
    const type = document.getElementById('budget-type').value;
    document.getElementById('budget-category-group').style.display = type === 'category' ? 'block' : 'none';
}

function renderBudgetCategorySelect() {
    const select = document.getElementById('budget-category');
    const cats = state.categories.expense;
    select.innerHTML = cats.map(c =>
        `<option value="${escapeAttr(c.id)}">${escapeHtml(c.icon)} ${escapeHtml(c.name)}</option>`
    ).join('');
}

let isSavingBudget = false;
// 新增预算保存入口：读取弹窗表单后调用 add_budget。
async function saveBudget() {
    // 当前前端固定按 month 周期创建预算；更细的预算逻辑由后端计算使用率和剩余金额。
    if (isSavingBudget) return;

    const type = document.getElementById('budget-type').value;
    const name = document.getElementById('budget-name').value.trim();
    const amount = parseFloat(document.getElementById('budget-amount').value);
    const categoryId = type === 'category' ? document.getElementById('budget-category').value : '';

    if (!name) {
        showToast('请输入预算名称', true);
        return;
    }
    if (!amount || amount <= 0) {
        showToast('请输入有效金额', true);
        return;
    }

    isSavingBudget = true;
    try {
        const result = await pywebview.api.add_budget(name, type, amount, categoryId, 'month', state.currentLedgerId);

        if (result && result.success === false) {
            showToast(result.error || '预算设置失败', true);
            return;
        }

        showToast('预算设置成功喵！');
        closeModal('budget-modal');
        loadBudgetsPage();
    } finally {
        isSavingBudget = false;
    }
}

// 注意：这里并非真正编辑，而是“点击卡片后询问是否删除预算”的简化实现。
async function showEditBudgetModal(id) {
    // 注意：这里名字叫 Edit，但当前实现实际执行的是“确认后删除预算”。
    // 简化：暂不支持编辑，点击时删除
    if (!confirm('要删除这个预算吗？')) return;
    await pywebview.api.delete_budget(id);
    showToast('预算已删除');
    loadBudgetsPage();
}

// ===== 账本管理 =====
// 账本页负责账本列表管理；真正的数据过滤上下文仍由 state.currentLedgerId 控制。
// 账本既有独立管理页，也会通过侧边栏 select 影响其他页面的数据上下文。
// 账本页加载入口：刷新账本卡片列表。
async function loadLedgersPage() {
    state.ledgers = await pywebview.api.get_ledgers();
    renderLedgersGrid();
}

// 账本卡片渲染：包含当前账本高亮、切换、编辑、归档/删除入口。
function renderLedgersGrid() {
    // 当前账本、默认账本、新建入口都在同一网格中渲染。
    const grid = document.getElementById('ledgers-grid');

    grid.innerHTML = state.ledgers.map(l => `
        <div class="ledger-card ${l.is_default ? 'default' : ''} ${l.id === state.currentLedgerId ? 'active' : ''}"
             onclick="switchLedger('${escapeJsString(l.id)}')">
            <div class="ledger-icon" style="background:${escapeAttr(safeCssHexColor(l.color, '#eee'))}">${escapeHtml(l.icon)}</div>
            <div class="ledger-name">${escapeHtml(l.name)}</div>
            <div class="ledger-stats">
                <span>创建于 ${escapeHtml(l.created_at?.slice(0, 10) || '-')}</span>
            </div>
        </div>
    `).join('') + `
        <div class="ledger-card ledger-add" onclick="showAddLedgerModal()">
            <span class="ledger-add-icon">+</span>
            <span>新建账本</span>
        </div>
    `;
}

// 从账本卡片直接切换全局账本上下文，并同步左侧下拉框与首页。
async function switchLedger(id) {
    // 账本切换后不会全页 reload，而是按当前页面类型做局部刷新。
    if (state.currentLedgerId === id) return;
    state.currentLedgerId = id;
    document.getElementById('current-ledger').value = id;
    // 同步刷新当前页面数据
    await refreshDashboard();
    if (state.currentPage === 'records') await loadRecords();
    else if (state.currentPage === 'stats') await loadStats();
    else if (state.currentPage === 'budgets') await loadBudgetsPage();
    loadLedgersPage();
    showToast('已切换账本');
}

let ledgerSelectedEmoji = '📚';
let ledgerSelectedColor = '#FFB7B2';

function showAddLedgerModal() {
    // 账本弹窗当前只支持新建，不支持编辑已有账本。
    document.getElementById('ledger-name').value = '';
    ledgerSelectedEmoji = '📚';
    ledgerSelectedColor = '#FFB7B2';

    const emojis = ['📚', '✈️', '🏠', '🎮', '💼', '🎁', '🏖️', '🚗', '💒', '🎓'];
    document.getElementById('ledger-emoji-picker').innerHTML = emojis.map(e =>
        `<span class="emoji-item ${e === ledgerSelectedEmoji ? 'selected' : ''}" data-emoji="${e}" onclick="selectLedgerEmoji('${e}')">${e}</span>`
    ).join('');

    document.getElementById('ledger-color-picker').innerHTML = COLOR_OPTIONS.map(c =>
        `<span class="color-item ${c === ledgerSelectedColor ? 'selected' : ''}" style="background:${c}" data-color="${c}" onclick="selectLedgerColor('${c}')"></span>`
    ).join('');

    openModal('ledger-modal');
}

function selectLedgerEmoji(emoji) {
    ledgerSelectedEmoji = emoji;
    document.querySelectorAll('#ledger-emoji-picker .emoji-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.emoji === emoji);
    });
}

function selectLedgerColor(color) {
    ledgerSelectedColor = color;
    document.querySelectorAll('#ledger-color-picker .color-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.color === color);
    });
}

let isSavingLedger = false;
// 账本保存入口：新增或编辑完成后，需要刷新左侧账本下拉和账本页卡片。
async function saveLedger() {
    // 成功后既要更新侧边栏下拉，也要刷新账本卡片页。
    if (isSavingLedger) return;

    const name = document.getElementById('ledger-name').value.trim();
    if (!name) {
        showToast('请输入账本名称', true);
        return;
    }

    isSavingLedger = true;
    try {
        const result = await pywebview.api.add_ledger(name, ledgerSelectedEmoji, ledgerSelectedColor);

        if (result && result.success === false) {
            showToast(result.error || '账本创建失败', true);
            return;
        }

        showToast('账本创建成功喵！');
        closeModal('ledger-modal');
        await loadLedgers();
        loadLedgersPage();
    } finally {
        isSavingLedger = false;
    }
}

// ===== 分类管理 =====
// 分类页同时展示支出/收入两套分类树，并在删除时走完整性确认弹窗处理引用关系。
// 分类管理页主要负责展示顶级分类、新增自定义分类、删除非系统分类。
// 分类页渲染入口：分别把 expense / income 分类交给 renderCategoryList。
async function renderCategoryManagement() {
    // 确保分类数据已加载
    if (!state.categories.expense.length && !state.categories.income.length) {
        await loadCategories();
    }
    renderCategoryList('expense', 'expense-categories');
    renderCategoryList('income', 'income-categories');
}

function renderCategoryList(type, containerId) {
    // 当前管理页只渲染顶级分类项；子分类新增入口仍预留了 parentId 参数。
    const cats = state.categories[type];
    const container = document.getElementById(containerId);

    container.innerHTML = cats.map(c => `
        <div class="category-manage-item">
            <div class="category-icon" style="background:${escapeAttr(safeCssHexColor(c.color, '#eee'))}">${escapeHtml(c.icon)}</div>
            <span class="category-name">${escapeHtml(c.name)}</span>
            ${!c.is_system ? `<button class="delete-btn" onclick="deleteCategory('${escapeJsString(c.id)}')">×</button>` : ''}
        </div>
    `).join('');
}

const EMOJI_OPTIONS = ['🍜', '🍔', '🍰', '🥤', '🚌', '🚗', '🏠', '💊', '📚', '🎮', '🎁', '🐱', '🐶', '🌸', '⭐', '💎'];
const COLOR_OPTIONS = ['#FFB7B2', '#FFDAC1', '#B5EAD7', '#C7CEEA', '#E0BBE4', '#FFD93D', '#A8D8EA', '#98D8AA', '#F6C6C6', '#D4D4D4'];

let selectedEmoji = EMOJI_OPTIONS[0];
let selectedColor = COLOR_OPTIONS[0];

function showAddCategoryModal(type, parentId = '') {
    // 新增分类弹窗会根据 type 区分收入/支出，根据 parentId 预留子分类能力。
    document.getElementById('cat-type').value = type;
    document.getElementById('cat-parent-id').value = parentId;
    document.getElementById('cat-name').value = '';
    selectedEmoji = EMOJI_OPTIONS[0];
    selectedColor = COLOR_OPTIONS[0];

    document.getElementById('emoji-picker').innerHTML = EMOJI_OPTIONS.map(e =>
        `<span class="emoji-item ${e === selectedEmoji ? 'selected' : ''}" data-emoji="${e}" onclick="selectEmoji('${e}')">${e}</span>`
    ).join('');

    document.getElementById('color-picker').innerHTML = COLOR_OPTIONS.map(c =>
        `<span class="color-item ${c === selectedColor ? 'selected' : ''}" style="background:${c}" data-color="${c}" onclick="selectColor('${c}')"></span>`
    ).join('');

    openModal('category-modal');
}

function selectEmoji(emoji) {
    selectedEmoji = emoji;
    document.querySelectorAll('#emoji-picker .emoji-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.emoji === emoji);
    });
}

function selectColor(color) {
    selectedColor = color;
    document.querySelectorAll('#color-picker .color-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.color === color);
    });
}

let isSavingCategory = false;
// 分类保存入口：读取弹窗中的类型、父级、名称、图标、颜色并调用 add_category。
async function saveCategory() {
    // 新增成功后，需要重新加载分类缓存，避免记一笔页和分类管理页状态不一致。
    if (isSavingCategory) return;

    const type = document.getElementById('cat-type').value;
    const parentId = document.getElementById('cat-parent-id').value;
    const name = document.getElementById('cat-name').value.trim();

    if (!name) {
        showToast('请输入分类名称', true);
        return;
    }

    isSavingCategory = true;
    try {
        const result = await pywebview.api.add_category(name, selectedEmoji, selectedColor, type, parentId);

        if (result && result.success === false) {
            showToast(result.error || '添加失败', true);
            return;
        }

        showToast('添加成功喵！');
        closeModal('category-modal');
        await loadCategories();
        renderCategoryManagement();
    } finally {
        isSavingCategory = false;
    }
}

// ===== 数据完整性处理 =====
// 删除分类/账户前，前端会先走 check 模式；若后端返回 needs_confirm，则在这里展示迁移/级联等选项。
let integrityContext = { type: '', id: '', strategy: 'migrate' };

// 分类删除前置入口：先走后端 check 模式，如果有关联数据再打开完整性确认弹窗。
async function deleteCategory(id) {
    // 分类删除不是直接删除，而是先请求后端评估影响范围。
    if (!id) {
        showToast('无效的分类ID', true);
        return;
    }
    try {
        const result = await pywebview.api.delete_category(id, 'check', '');

        if (result.success) {
            showToast('已删除');
            await loadCategories();
            renderCategoryManagement();
            return;
        }

        if (result.needs_confirm) {
            showIntegrityModal('category', id, result);
        } else {
            showToast(result.message || '删除失败', true);
        }
    } catch (err) {
        console.error('删除分类失败:', err);
        showToast('删除失败: ' + err, true);
    }
}

// 账户删除前置入口：与删除分类类似，先检查是否有关联记录或余额。
async function deleteAccountWithCheck(id) {
    // 账户删除同样采用“check -> 确认弹窗 -> 真正执行”的两段式流程。
    if (!id) {
        showToast('无效的账户ID', true);
        return;
    }
    try {
        const result = await pywebview.api.delete_account(id, 'check', '');

        if (result.success) {
            showToast('已删除');
            await loadAccounts();
            loadAccountsPage();
            return;
        }

        if (result.needs_confirm) {
            showIntegrityModal('account', id, result);
        } else {
            showToast(result.message || '删除失败', true);
        }
    } catch (err) {
        console.error('删除账户失败:', err);
        showToast('删除失败: ' + err, true);
    }
}

// 展示完整性确认弹窗：把影响范围、处理策略、迁移目标等都渲染到统一弹窗。
function showIntegrityModal(type, id, checkResult) {
    // 这个弹窗的职责是把后端返回的影响统计翻译成用户可选的处理策略。
    integrityContext = { type, id, strategy: 'migrate' };

    const isCategory = type === 'category';
    const itemName = isCategory ? checkResult.category_name : checkResult.account_name;

    document.getElementById('integrity-title').textContent = `删除${isCategory ? '分类' : '账户'}`;
    document.getElementById('integrity-message').textContent = checkResult.message;

    // 显示影响统计
    const statsHtml = [];
    if (checkResult.affected_records > 0) {
        statsHtml.push(`<span>📝 记录: <span class="count">${checkResult.affected_records}</span> 条</span>`);
    }
    if (checkResult.affected_budgets > 0) {
        statsHtml.push(`<span>🎯 预算: <span class="count">${checkResult.affected_budgets}</span> 个</span>`);
    }
    if (checkResult.current_balance !== undefined && checkResult.current_balance !== 0) {
        statsHtml.push(`<span>💰 余额: <span class="count">¥${checkResult.current_balance.toFixed(2)}</span></span>`);
    }
    document.getElementById('integrity-stats').innerHTML = statsHtml.join('');

    // 显示处理选项
    let options = [];
    if (isCategory) {
        options = [
            { value: 'migrate', title: '迁移到其他分类', desc: `将相关记录和预算迁移到"${checkResult.category_type === 'expense' ? '其他支出' : '其他收入'}"` },
            { value: 'cascade', title: '连同删除', desc: '删除该分类下所有关联的记录和预算（不可恢复）' }
        ];
    } else {
        options = [
            { value: 'migrate', title: '迁移到其他账户', desc: '将记录和余额转移到默认账户' },
            { value: 'nullify', title: '仅清除关联', desc: '保留记录但清除账户关联' },
            { value: 'cascade', title: '连同删除', desc: '删除该账户下所有记录（不可恢复）' }
        ];
    }

    document.getElementById('integrity-options').innerHTML = options.map((opt, i) => `
        <div class="integrity-option ${i === 0 ? 'selected' : ''}" onclick="selectIntegrityOption('${opt.value}')">
            <span class="option-radio"></span>
            <div class="option-content">
                <div class="option-title">${opt.title}</div>
                <div class="option-desc">${opt.desc}</div>
            </div>
        </div>
    `).join('');

    // 迁移目标选择（如果需要）
    const migrateGroup = document.getElementById('integrity-migrate-group');
    const migrateSelect = document.getElementById('integrity-migrate-to');

    if (isCategory) {
        const cats = state.flatCategories[checkResult.category_type].filter(c => c.id !== id && !c.parent_id);
        migrateSelect.innerHTML = cats.map(c =>
            `<option value="${escapeAttr(c.id)}" ${c.id === checkResult.suggested_migrate_to ? 'selected' : ''}>${escapeHtml(c.icon)} ${escapeHtml(c.name)}</option>`
        ).join('');
    } else {
        const accs = state.accounts.filter(a => a.id !== id);
        migrateSelect.innerHTML = accs.map(a =>
            `<option value="${escapeAttr(a.id)}" ${a.id === checkResult.suggested_migrate_to ? 'selected' : ''}>${escapeHtml(a.icon)} ${escapeHtml(a.name)}</option>`
        ).join('');
    }
    migrateGroup.style.display = 'block';

    openModal('integrity-modal');
}

function selectIntegrityOption(strategy) {
    // 当前选中的删除策略会写入 integrityContext，供 confirmIntegrityAction 最终提交。
    integrityContext.strategy = strategy;
    document.querySelectorAll('.integrity-option').forEach(el => {
        el.classList.toggle('selected', el.querySelector('.option-title').textContent.includes(
            strategy === 'migrate' ? '迁移' : strategy === 'nullify' ? '清除关联' : '连同删除'
        ));
    });

    // 迁移选项时显示目标选择
    document.getElementById('integrity-migrate-group').style.display =
        strategy === 'migrate' ? 'block' : 'none';
}

// 完整性确认提交入口：根据弹窗上下文决定继续删除分类还是账户。
async function confirmIntegrityAction() {
    // 真正执行删除 / 迁移 / 级联 的提交入口。
    const { type, id, strategy } = integrityContext;
    if (!type || !id) {
        showToast('无效的删除对象', true);
        return;
    }
    const migrateTo = strategy === 'migrate' ? document.getElementById('integrity-migrate-to').value : '';

    try {
        let result;
        if (type === 'category') {
            result = await pywebview.api.delete_category(id, strategy, migrateTo);
        } else {
            result = await pywebview.api.delete_account(id, strategy, migrateTo);
        }

        if (result.success) {
            showToast(`删除成功，${result.action === 'migrate' ? '已迁移' : result.action === 'cascade' ? '已级联删除' : '已处理'} ${result.affected_records || 0} 条记录`);
            closeModal('integrity-modal');

            if (type === 'category') {
                await loadCategories();
                renderCategoryManagement();
            } else {
                await loadAccounts();
                loadAccountsPage();
            }
            refreshDashboard();
        } else {
            showToast(result.message || '操作失败', true);
        }
    } catch (err) {
        console.error('完整性处理失败:', err);
        showToast('操作失败: ' + err, true);
    }
}

// ===== 数据导出 =====
// 这里是侧边栏“导出”按钮对应的 CSV 导出能力，不同于备份页的 JSON 整体备份。
// 打开 CSV 导出弹窗，并预设日期。
function showExportModal() {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    document.getElementById('export-start').value = firstDay.toISOString().split('T')[0];
    document.getElementById('export-end').value = today.toISOString().split('T')[0];
    openModal('export-modal');
}

let isExporting = false;
// CSV 导出执行入口：根据导出类型分别调用 export_records_csv / export_summary_csv。
async function doExport() {
    // 导出成功后由前端构造 Blob 下载，不经过后端写文件。
    if (isExporting) return;

    const type = document.getElementById('export-type').value;
    const start = document.getElementById('export-start').value;
    const end = document.getElementById('export-end').value;

    isExporting = true;
    try {
        let csv;
        if (type === 'records') {
            csv = await pywebview.api.export_records_csv(start, end, state.currentLedgerId);
        } else {
            csv = await pywebview.api.export_summary_csv(new Date().getFullYear(), state.currentLedgerId);
        }

        // 下载 CSV
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `喵喵存金罐_${type === 'records' ? '明细' : '汇总'}_${start}_${end}.csv`;
        a.click();
        URL.revokeObjectURL(url);

        showToast('导出成功喵！');
        closeModal('export-modal');
    } finally {
        isExporting = false;
    }
}

// ===== 弹窗 =====
// 所有 modal 共用最简单的 show/hide class 方案，没有额外状态机。
// 通用弹窗开关：所有 modal 都走这里控制 class。
function openModal(id) {
    document.getElementById(id).classList.add('show');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('show');
}

// ===== Toast =====
// 全局轻提示统一入口：成功/失败文案最终都走这里。
// 通用轻提示：成功/失败都通过这里给用户短反馈。
function showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    const msgEl = document.getElementById('toast-message');
    const iconEl = toast.querySelector('.toast-icon');

    msgEl.textContent = msg;
    iconEl.textContent = isError ? '😿' : '😺';
    toast.className = 'toast' + (isError ? ' error' : '');

    setTimeout(() => toast.classList.add('hidden'), 2500);
}

// 旧的深色模式代码已被多主题系统替代 (initTheme)

// ===== 数据备份与恢复 =====
// 备份页走的是“完整 JSON 导出/导入”链路，与 CSV 导出互相独立。
// 进入备份页时的初始化入口：先刷新统计卡片，帮助用户确认当前数据规模。
async function initBackupPage() {
    await updateBackupStats();
}

async function updateBackupStats() {
    // 备份页顶部统计卡片的数据源就是后端 get_data_stats。
    try {
        const stats = await pywebview.api.get_data_stats();
        document.getElementById('stat-categories').textContent = stats.categories ?? '-';
        document.getElementById('stat-accounts').textContent = stats.accounts ?? '-';
        document.getElementById('stat-ledgers').textContent = stats.ledgers ?? '-';
        document.getElementById('stat-budgets').textContent = stats.budgets ?? '-';
        document.getElementById('stat-records').textContent = stats.records ?? '-';
    } catch (e) {
        console.error('Failed to load backup stats:', e);
    }
}

// 导出整包 JSON 备份：调用 export_data，并通过浏览器下载能力导出文件。
async function exportBackupData() {
    // 完整备份链路：export_data -> 生成 JSON Blob -> 浏览器下载。
    const resultEl = document.getElementById('backup-result');
    resultEl.style.display = 'none';
    resultEl.className = 'backup-result';

    try {
        const data = await pywebview.api.export_data();
        const jsonStr = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const now = new Date();
        const ts = now.toISOString().slice(0, 19).replace(/[:\-T]/g, '').replace(/(\d{8})(\d{6})/, '$1_$2');
        const filename = `喵喵存金罐_备份_${ts}.json`;

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        resultEl.className = 'backup-result backup-success';
        resultEl.innerHTML = `
            <div class="backup-result-title">✅ 导出成功喵～</div>
            <div class="backup-result-details">
                备份文件已下载：<strong>${filename}</strong>
                <ul>
                    <li>分类：${data.data.categories?.length ?? 0} 条</li>
                    <li>账户：${data.data.accounts?.length ?? 0} 条</li>
                    <li>账本：${data.data.ledgers?.length ?? 0} 条</li>
                    <li>预算：${data.data.budgets?.length ?? 0} 条</li>
                    <li>记录：${data.data.records?.length ?? 0} 条</li>
                </ul>
            </div>
        `;
        resultEl.style.display = '';
    } catch (e) {
        resultEl.className = 'backup-result backup-error';
        resultEl.innerHTML = `
            <div class="backup-result-title">❌ 导出失败</div>
            <div class="backup-result-details">${escapeHtml(e.message || String(e))}</div>
        `;
        resultEl.style.display = '';
    }
}

// 导入整包 JSON 备份：读取文件内容、解析 JSON、调用 import_data，并展示导入结果。
async function importBackupData(event) {
    // 导入是高影响操作：先前端校验基本结构，再提示确认，再调用后端 import_data。
    const file = event.target.files?.[0];
    if (!file) return;

    const resultEl = document.getElementById('backup-result');
    resultEl.style.display = 'none';
    resultEl.className = 'backup-result';

    try {
        const text = await file.text();
        const jsonData = JSON.parse(text);

        if (!jsonData.data) {
            throw new Error('无效的备份文件格式：缺少 data 字段');
        }

        if (!confirm('导入将覆盖现有数据，是否继续？')) {
            event.target.value = '';
            return;
        }

        const result = await pywebview.api.import_data(jsonData);

        if (result.success) {
            resultEl.className = 'backup-result backup-success';
            resultEl.innerHTML = `
                <div class="backup-result-title">✅ 导入成功喵～</div>
                <div class="backup-result-details">
                    已导入数据：
                    <ul>
                        <li>分类：${result.imported.categories} 条</li>
                        <li>账户：${result.imported.accounts} 条</li>
                        <li>账本：${result.imported.ledgers} 条</li>
                        <li>预算：${result.imported.budgets} 条</li>
                        <li>记录：${result.imported.records} 条</li>
                    </ul>
                    页面将自动刷新以加载新数据...
                </div>
            `;
            resultEl.style.display = '';
            await updateBackupStats();
            setTimeout(() => location.reload(), 2000);
        } else {
            throw new Error(result.error || '导入失败');
        }
    } catch (e) {
        resultEl.className = 'backup-result backup-error';
        resultEl.innerHTML = `
            <div class="backup-result-title">❌ 导入失败</div>
            <div class="backup-result-details">${escapeHtml(e.message || String(e))}</div>
        `;
        resultEl.style.display = '';
    }

    event.target.value = '';
}
