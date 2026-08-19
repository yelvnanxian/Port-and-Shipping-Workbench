import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Anchor,
  Archive,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileCheck2,
  Filter,
  Globe2,
  LayoutDashboard,
  LoaderCircle,
  Menu,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Save,
  Send,
  Server,
  Search,
  Settings,
  Ship,
  SlidersHorizontal,
  Timer,
  Upload,
  X,
} from 'lucide-react';
import type { AutomationStatus, CarrierSource, DashboardData, Shipment, ShipmentStatus } from './types';

type PageId = 'overview' | 'tracking' | 'sources' | 'automation' | 'exports' | 'settings';

interface SettingsView {
  enabled: boolean;
  browserAutomationEnabled: boolean;
  schedule: Array<{ time: string; cron: string }>;
  timezone: string;
  notificationConfigured: boolean;
  webhookPreview: string;
}

const navItems: Array<{ id: PageId; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: '运营总览', icon: LayoutDashboard },
  { id: 'tracking', label: '船期追踪', icon: Ship },
  { id: 'sources', label: '数据源管理', icon: Database },
  { id: 'automation', label: '自动化任务', icon: Timer },
  { id: 'exports', label: '导出与备份', icon: FileSpreadsheet },
];

const pageTitles: Record<PageId, string> = {
  overview: '运营总览', tracking: '船期追踪', sources: '数据源管理', automation: '自动化任务', exports: '导出与备份', settings: '系统设置',
};

const statusOptions: Array<'全部状态' | ShipmentStatus> = ['全部状态', '待靠泊', '作业中', '已卸船', '计划变更'];

const carrierColors: Record<string, string> = {
  COSCO: '#117b70',
  MAERSK: '#258fb8',
  ONE: '#b92d70',
  'CMA CGM': '#315cad',
  EVERGREEN: '#3b8d59',
};

const carrierLabels: Record<string, string> = {
  ONE: '海洋网联', MAERSK: '马士基', MSC: '地中海', EVERGREEN: '长荣', OOCL: '东方海外',
  WANHAI: '万海', ZIM: '以星', MATSON: '美森', YANGMING: '阳明', SMLINE: '森罗',
  CMA: '达飞', COSCO: '中远海运', HAPAG: '赫伯罗特', HEDE: '合德', HMM: '韩新海运',
};

function carrierLabel(code: string, fallback = '') {
  return carrierLabels[code] || fallback || code;
}

function formatDateTime(value: string | null, twoLines = false) {
  if (!value) return <span className="empty-value">待更新</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return twoLines ? <strong className="date-only-value">{value}</strong> : value;
  const datePart = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date);
  const timePart = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  return twoLines ? <><strong>{datePart}</strong><span>{timePart}</span></> : `${datePart} ${timePart}`;
}

function timeAgo(value: string) {
  if (new Date(value).getFullYear() <= 1970) return '待首次查询';
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    const detail = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    throw new Error(detail ? `服务返回了非 JSON 内容：${detail}` : `服务返回了非 JSON 内容（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload && 'message' in payload ? String(payload.message) : `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

function StatusBadge({ status }: { status: ShipmentStatus }) {
  const config = {
    待靠泊: { icon: Clock3, className: 'pending' },
    作业中: { icon: RefreshCw, className: 'working' },
    已卸船: { icon: Check, className: 'done' },
    计划变更: { icon: CircleAlert, className: 'changed' },
  }[status];
  const Icon = config.icon;
  return <span className={`status-badge ${config.className}`}><Icon size={13} />{status}</span>;
}

function VesselStateBadge({ shipment }: { shipment: Shipment }) {
  const state = shipment.vesselState || ({ 待靠泊: '未到港未卸船', 作业中: '已到港未卸船', 已卸船: '已到港已卸船', 计划变更: '未到港未卸船' } as const)[shipment.status];
  const className = state === '已到港已卸船' ? 'done' : state === '已到港未卸船' ? 'working' : 'pending';
  const Icon = className === 'done' ? Check : className === 'working' ? RefreshCw : Clock3;
  return <span className={`status-badge ${className}`}><Icon size={13} />{state}</span>;
}

function ProgressBadge({ shipment }: { shipment: Shipment }) {
  const progress = shipment.progress || (shipment.status === '计划变更' ? '失败' : '已完成');
  return <span className={`progress-badge progress-${progress}`}>{progress}</span>;
}

function CarrierMark({ code }: { code: string }) {
  return <span className="carrier-mark" style={{ '--carrier-color': carrierColors[code] || '#71818a' } as React.CSSProperties}>
    {code === 'CMA CGM' ? 'CMA' : code.slice(0, 3)}
  </span>;
}

export default function App() {
  const [activePage, setActivePage] = useState<PageId>(() => {
    const page = window.location.hash.replace('#', '') as PageId;
    return pageTitles[page] ? page : 'overview';
  });
  const [data, setData] = useState<DashboardData | null>(null);
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState('');
  const [carrier, setCarrier] = useState('全部船司');
  const [status, setStatus] = useState<(typeof statusOptions)[number]>('全部状态');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Shipment | null>(null);
  const [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeText, setIntakeText] = useState('');
  const [intakeSaving, setIntakeSaving] = useState(false);
  const [moreFilterOpen, setMoreFilterOpen] = useState(false);
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [onlyException, setOnlyException] = useState(false);
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  const [denseTable, setDenseTable] = useState(false);
  const [showNoteColumn, setShowNoteColumn] = useState(true);
  const [showUpdatedColumn, setShowUpdatedColumn] = useState(true);
  const [pageSize, setPageSize] = useState(20);
  const [pageNumber, setPageNumber] = useState(1);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const moreFilterRef = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  function navigate(page: PageId) {
    setActivePage(page);
    window.location.hash = page;
    setMobileNav(false);
    setProfileMenuOpen(false);
  }

  useEffect(() => {
    const onHashChange = () => {
      const page = window.location.hash.replace('#', '') as PageId;
      if (pageTitles[page]) setActivePage(page);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  async function load(endpoint = '/api/dashboard') {
    const payload = await apiRequest<DashboardData>(endpoint, { method: endpoint.includes('sync') ? 'POST' : 'GET' });
    setData(payload);
  }

  async function loadAutomation() {
    setAutomation(await apiRequest<AutomationStatus>('/api/automation'));
  }

  useEffect(() => {
    Promise.all([load(), loadAutomation()]).catch((error) => setToast(error.message)).finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    const normalized = query.trim().toLowerCase();
    return data.shipments.filter((item) => {
      const matchesQuery = !normalized || [item.billNo, item.containerNo, item.carrier, item.carrierCode]
        .some((field) => field.toLowerCase().includes(normalized));
      const matchesCarrier = carrier === '全部船司' || item.carrierCode === carrier;
      const matchesStatus = status === '全部状态' || item.status === status;
      const matchesIncomplete = !onlyIncomplete || item.vesselState !== '已到港已卸船';
      const matchesException = !onlyException || item.status === '计划变更' || item.progress === '失败';
      return matchesQuery && matchesCarrier && matchesStatus && matchesIncomplete && matchesException;
    });
  }, [data, query, carrier, status, onlyIncomplete, onlyException]);

  useEffect(() => {
    setPageNumber(1);
  }, [query, carrier, status, onlyIncomplete, onlyException, pageSize]);

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      if (moreFilterRef.current && !moreFilterRef.current.contains(event.target as Node)) setMoreFilterOpen(false);
    };
    document.addEventListener('mousedown', closeMenu);
    return () => document.removeEventListener('mousedown', closeMenu);
  }, []);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleRows = filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);

  const metrics = useMemo(() => {
    const records = data?.shipments || [];
    return {
      total: records.length,
      arriving: records.filter((item) => item.status === '待靠泊' && item.eta && new Date(item.eta).getTime() <= Date.now() + 48 * 60 * 60 * 1000).length,
      working: records.filter((item) => item.status === '作业中').length,
      completed: records.filter((item) => item.status === '已卸船').length,
      changed: records.filter((item) => item.status === '计划变更').length,
    };
  }, [data]);

  async function handleSync() {
    setSyncing(true);
    try {
      if (!automation?.workbook) throw new Error('请先导入 Excel 或新增单号');
      const payload = await apiRequest<{ run: { total: number; failed: number }; dashboard: DashboardData; automation: AutomationStatus }>('/api/automation/run', { method: 'POST' });
      setData(payload.dashboard);
      setAutomation(payload.automation);
      setToast(`已完成 ${payload.run.total} 条查询，失败 ${payload.run.failed} 条`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : '同步失败');
    } finally {
      setSyncing(false);
    }
  }

  async function handleUpload(file?: File) {
    if (!file) return;
    const form = new FormData();
    form.append('workbook', file);
    setSyncing(true);
    try {
      const payload = await apiRequest<{ workbook: { records: number }; dashboard: DashboardData; automation: AutomationStatus }>('/api/workbooks/upload', { method: 'POST', body: form });
      setData(payload.dashboard);
      setAutomation(payload.automation);
      setSelected(new Set());
      setToast(`已导入 ${payload.workbook.records} 条记录，原文件已安全接管`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Excel 导入失败');
    } finally {
      setSyncing(false);
      if (uploadInput.current) uploadInput.current.value = '';
    }
  }

  async function handleIntake() {
    const entries = intakeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const parts = line.split(/[\t,，;； ]+/).filter(Boolean);
      return { billNo: parts[0] || '', containerNo: parts[1] || '', carrierHint: parts.slice(2).join(' ') };
    }).filter((entry) => entry.billNo);
    if (!entries.length) {
      setToast('请先输入提单号，每行一个；可选填柜号和船司备注');
      return;
    }
    setIntakeSaving(true);
    try {
      const payload = await apiRequest<{ added: unknown[]; duplicates: unknown[] }>('/api/intake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries }) });
      const runPayload = await apiRequest<{ run: { success: number }; dashboard: DashboardData; automation: AutomationStatus }>('/api/automation/run', { method: 'POST' });
      setData(runPayload.dashboard);
      setAutomation(runPayload.automation);
      setIntakeText('');
      setIntakeOpen(false);
      setToast(`已加入 ${payload.added.length} 条，重复 ${payload.duplicates.length} 条；查询完成 ${runPayload.run.success} 条`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : '单号添加失败');
    } finally {
      setIntakeSaving(false);
    }
  }

  async function handleExport() {
    if (!automation?.workbook) {
      setToast('请先导入 Excel 或新增单号');
      return;
    }
    window.location.href = '/api/workbooks/current';
    setToast('正在下载已更新的 Excel');
  }

  async function handleToggleAutomation(enabled: boolean) {
    try {
      const payload = await apiRequest<{ automation: AutomationStatus }>('/api/automation/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      setAutomation(payload.automation);
      setToast(enabled ? '定时任务已启用' : '定时任务已停用');
    } catch (error) {
      setToast(error instanceof Error ? error.message : '自动化设置保存失败');
    }
  }

  async function handleCreateBackup() {
    try {
      await apiRequest('/api/backups/create', { method: 'POST' });
      setToast('已创建手动备份');
    } catch (error) {
      setToast(error instanceof Error ? error.message : '创建备份失败');
    }
  }

  async function handleRestoreBackup(name: string) {
    if (!window.confirm(`确认恢复备份 ${name}？当前文件会先自动备份。`)) return;
    try {
      const payload = await apiRequest<{ dashboard: DashboardData; automation: AutomationStatus }>(`/api/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' });
      setData(payload.dashboard);
      setAutomation(payload.automation);
      setSelected(new Set());
      setToast('备份已恢复，恢复前文件也已自动备份');
    } catch (error) {
      setToast(error instanceof Error ? error.message : '恢复备份失败');
    }
  }

  function toggleAll() {
    const allSelected = visibleRows.length > 0 && visibleRows.every((item) => selected.has(item.id));
    setSelected((previous) => {
      const next = new Set(previous);
      visibleRows.forEach((item) => allSelected ? next.delete(item.id) : next.add(item.id));
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const allSelected = visibleRows.length > 0 && visibleRows.every((item) => selected.has(item.id));
  const carriers = Array.from(new Set(data?.shipments.map((item) => item.carrierCode) || []));

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
        <div className="brand"><div className="brand-icon"><Anchor size={22} /></div><div><strong>港航工作台</strong><span>PORT OPS</span></div></div>
        <nav>
          <span className="nav-caption">工作台</span>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={activePage === id ? 'active' : ''} onClick={() => navigate(id)}><Icon size={18} /><span>{label}</span>{activePage === id && <span className="nav-dot" />}</button>
          ))}
          <span className="nav-caption lower">管理</span>
          <button className={activePage === 'settings' ? 'active' : ''} onClick={() => navigate('settings')}><Settings size={18} /><span>系统设置</span>{activePage === 'settings' && <span className="nav-dot" />}</button>
        </nav>
        <div className="sidebar-foot">
          <div className="system-health"><span className="health-dot" /><div><strong>采集服务正常</strong><span>{data ? `${data.sources.length} 个数据源在线` : '正在连接服务'}</span></div></div>
          <div className="user-card-wrap">
            <button className="user-card" onClick={() => navigate('settings')}><div className="avatar">A4</div><div><strong>A4专用版</strong><span>工作台管理员 · 打开系统设置</span></div></button>
            <button className="user-menu-button" aria-label="打开工作台菜单" title="工作台菜单" onClick={() => setProfileMenuOpen((value) => !value)}><MoreHorizontal size={17} /></button>
            {profileMenuOpen && <div className="user-menu"><button onClick={() => navigate('settings')}><Settings size={14} />系统设置</button><button onClick={() => { setProfileMenuOpen(false); window.location.reload(); }}><RefreshCw size={14} />重新加载</button></div>}
          </div>
        </div>
      </aside>

      {mobileNav && <button className="mobile-overlay" aria-label="关闭菜单" onClick={() => setMobileNav(false)} />}

      <main>
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNav(true)}><Menu size={21} /></button>
          <div className="breadcrumb"><span>港航运营</span><ChevronRight size={14} /><strong>{pageTitles[activePage]}</strong></div>
          <div className="header-actions"><button className="icon-button" title="查看自动化任务" onClick={() => navigate('automation')}><Bell size={19} /><span className="notification-dot" /></button><span className="today"><CalendarDays size={16} />2026年8月18日 · 周二</span></div>
        </header>

        <div className="content">
          <div className={activePage === 'overview' ? '' : 'hidden-page'}>
          <section className="page-heading">
            <div><p className="eyebrow">OPERATIONS OVERVIEW</p><h1>运营总览</h1><p>集中追踪船期、靠泊与卸船动态，及时掌握异常变化。</p></div>
            <div className="heading-actions"><button className="secondary-button add-record-button" onClick={() => setIntakeOpen(true)}><Ship size={17} />新增单号</button><button className="secondary-button" onClick={handleExport}><Download size={17} />导出 Excel</button><button className="primary-button" onClick={handleSync} disabled={syncing}><RefreshCw size={17} className={syncing ? 'spin' : ''} />{syncing ? '同步中…' : '同步最新数据'}</button></div>
          </section>

          <section className="automation-panel">
            <div className="automation-main">
              <div className="automation-symbol"><Timer size={20} /></div>
              <div><div className="automation-heading"><strong>定时自动更新</strong><span className="mode-tag live">真实官网数据</span></div><p>每天 09:00、11:00、17:30 自动查询未完成记录</p></div>
            </div>
            <div className="automation-facts">
              <div><FileCheck2 size={16} /><span>Excel 文件</span><strong>{automation?.workbook ? `${automation.workbook.records} 条记录` : '尚未导入'}</strong></div>
              <div><Timer size={16} /><span>下次计划</span><strong>{automation?.schedule.map((item) => item.time).join(' · ') || '读取中'}</strong></div>
              <div><MessageSquare size={16} /><span>企业微信</span><strong>{automation?.notificationConfigured ? '已配置' : '前往系统设置配置'}</strong></div>
            </div>
            <div className="automation-actions">
              <a className="template-link" href="/api/workbooks/template">下载模板</a>
              {automation?.workbook && <a className="template-link" href="/api/workbooks/current">下载当前 Excel</a>}
              <button className="upload-button" onClick={() => uploadInput.current?.click()} disabled={syncing}><Upload size={15} />导入 Excel</button>
              <input ref={uploadInput} className="hidden-input" type="file" accept=".xlsx" onChange={(event) => handleUpload(event.target.files?.[0])} />
            </div>
          </section>

          <section className="metrics-grid">
            <MetricCard title="追踪中的货物" value={metrics.total} suffix="票" trend={`覆盖 ${data?.sources.length || 0} 家船司`} icon={<Ship size={20} />} tone="navy" />
            <MetricCard title="未来 48h 到港" value={metrics.arriving} suffix="票" trend="需要持续关注" icon={<Clock3 size={20} />} tone="teal" />
            <MetricCard title="正在码头作业" value={metrics.working} suffix="票" trend="卸船作业进行中" icon={<Anchor size={20} />} tone="blue" />
            <MetricCard title="已完成卸船" value={metrics.completed} suffix="票" trend="后续不再重复查询" icon={<Check size={20} />} tone="green" />
            <MetricCard title="计划有变更" value={metrics.changed} suffix="票" trend="建议优先处理" icon={<CircleAlert size={20} />} tone="orange" alert />
          </section>

          <section className="source-strip">
            <div className="source-title"><div className="source-icon"><Database size={19} /></div><div><strong>数据源状态</strong><span>真实官网解析器模式 · 未完成联调的官网会明确记录失败原因</span></div></div>
            <div className="source-list">
              {(data?.sources || []).map((source) => <SourcePill key={source.id} source={source} />)}
            </div>
            <button className="manage-link" onClick={() => navigate('sources')}>管理数据源<ChevronRight size={15} /></button>
          </section>

          <section className={`table-card ${denseTable ? 'compact-table' : ''}`}>
            <div className="table-header">
              <div><h2>船期追踪</h2><span>共 {filtered.length} 条记录</span></div>
              <button className="view-settings" onClick={() => setDisplaySettingsOpen(true)}><SlidersHorizontal size={16} />显示设置</button>
            </div>
            <div className="filters-row">
              <label className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提单号、柜号或船司" />{query && <button onClick={() => setQuery('')}><X size={14} /></button>}</label>
              <div className="select-wrap"><select value={carrier} onChange={(event) => setCarrier(event.target.value)}><option value="全部船司">全部船司</option>{carriers.map((item) => <option key={item} value={item}>{carrierLabel(item)}</option>)}</select><ChevronDown size={15} /></div>
              <div className="select-wrap"><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>{statusOptions.map((item) => <option key={item}>{item}</option>)}</select><ChevronDown size={15} /></div>
              <div className="more-filter-wrap" ref={moreFilterRef}><button className={`filter-button ${onlyIncomplete || onlyException ? 'filter-active' : ''}`} onClick={(event) => { event.stopPropagation(); setMoreFilterOpen((value) => !value); }}><Filter size={16} />更多筛选</button>{moreFilterOpen && <div className="more-filter-menu" onClick={(event) => event.stopPropagation()}><strong>高级筛选</strong><label><input type="checkbox" checked={onlyIncomplete} onChange={(event) => setOnlyIncomplete(event.target.checked)} />只看未完成记录</label><label><input type="checkbox" checked={onlyException} onChange={(event) => setOnlyException(event.target.checked)} />只看失败或异常</label><button onClick={() => { setOnlyIncomplete(false); setOnlyException(false); setMoreFilterOpen(false); }}>重置高级筛选</button></div>}</div>
              {(query || carrier !== '全部船司' || status !== '全部状态' || onlyIncomplete || onlyException) && <button className="clear-filter" onClick={() => { setQuery(''); setCarrier('全部船司'); setStatus('全部状态'); setOnlyIncomplete(false); setOnlyException(false); }}>清除筛选</button>}
            </div>

            <div className="table-scroll">
              <table>
                <thead><tr>
                  <th className="check-col"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                  <th>船司</th><th>到港时间<br/><span>ATA / ETA</span></th><th>提单号</th><th>柜号</th><th>卸船时间</th><th>船只状态</th>{showUpdatedColumn && <th>最后更新时间</th>}{showNoteColumn && <th>备注</th>}<th>进度</th><th />
                </tr></thead>
                <tbody>
                  {loading ? <tr><td colSpan={11}><div className="loading-state"><LoaderCircle className="spin" />正在汇总船司数据…</div></td></tr> : filtered.length === 0 ? <tr><td colSpan={11}><div className="empty-state"><Search size={24} /><strong>没有匹配的船期记录</strong><span>调整关键词或筛选条件后再试</span></div></td></tr> : visibleRows.map((item) => (
                    <tr key={item.id} className={selected.has(item.id) ? 'selected-row' : ''}>
                      <td className="check-col"><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleOne(item.id)} /></td>
                      <td><div className="carrier-cell"><CarrierMark code={item.carrierCode} /><div><strong>{carrierLabel(item.carrierCode, item.carrier)}</strong><span>{item.carrierCode}</span></div></div></td>
                      <td><div className="date-cell eta">{formatDateTime(item.eta, true)}</div></td>
                      <td><strong className="mono">{item.billNo}</strong></td>
                      <td><strong className="mono muted-strong">{item.containerNo || '—'}</strong></td>
                      <td><div className="date-cell discharge">{formatDateTime(item.dischargeTime, true)}</div></td>
                      <td><VesselStateBadge shipment={item} /></td>
                      {showUpdatedColumn && <td><div className="update-cell"><span>{timeAgo(item.lastUpdated)}</span><small>{formatDateTime(item.lastUpdated)}</small></div></td>}
                      {showNoteColumn && <td><span className="note-cell" title={item.note}>{item.note || '—'}</span></td>}
                      <td><ProgressBadge shipment={item} /></td>
                      <td><button className="row-action" onClick={() => setDetail(item)}><ChevronRight size={17} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-footer"><span>当前显示 {visibleRows.length} / {filtered.length} 条 · 已选择 {selected.size} 条</span><div><span>每页 {pageSize} 条</span><button disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => Math.max(1, value - 1))}>上一页</button>{Array.from({ length: pageCount }, (_, index) => index + 1).slice(Math.max(0, pageNumber - 3), pageNumber + 2).map((number) => <button key={number} className={number === pageNumber ? 'page-active' : ''} onClick={() => setPageNumber(number)}>{number}</button>)}<button disabled={pageNumber >= pageCount} onClick={() => setPageNumber((value) => Math.min(pageCount, value + 1))}>下一页</button></div></div>
          </section>
          <p className="legal-note">数据仅用于运营辅助，最终船期以船司及码头官方信息为准。</p>
          </div>
          {activePage !== 'overview' && <ModulePage page={activePage} data={data} automation={automation} syncing={syncing} onSync={handleSync} onToggleAutomation={handleToggleAutomation} onCreateBackup={handleCreateBackup} onRestoreBackup={handleRestoreBackup} onAutomationUpdated={setAutomation} onUpload={() => uploadInput.current?.click()} onToast={setToast} onOpenDetail={setDetail} />}
        </div>
      </main>

      {intakeOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => !intakeSaving && setIntakeOpen(false)}>
        <section className="intake-modal" role="dialog" aria-modal="true" aria-labelledby="intake-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading">
            <div><p className="eyebrow">SHIPMENT INTAKE</p><h2 id="intake-title">新增查询单号</h2><p>每行录入一票，系统会按提单号前缀自动识别船司并生成 Excel。</p></div>
            <button className="drawer-close" aria-label="关闭" onClick={() => setIntakeOpen(false)} disabled={intakeSaving}><X size={19} /></button>
          </div>
          <label className="intake-label" htmlFor="intake-records">提单号　柜号　船司备注（可选）</label>
          <textarea id="intake-records" className="intake-textarea" autoFocus value={intakeText} onChange={(event) => setIntakeText(event.target.value)} placeholder={'OOLU2171963250  OOCU7496887  东方海外\n每行一条，也支持从 Excel 直接粘贴'} />
          <div className="intake-example"><CircleAlert size={15} /><span><strong>东方海外示例：</strong>OOLU2171963250　OOCU7496887　东方海外。柜号和船司可不填；提单号必填。</span></div>
          <div className="modal-actions"><button className="secondary-button" onClick={() => setIntakeOpen(false)} disabled={intakeSaving}>取消</button><button className="primary-button" onClick={handleIntake} disabled={intakeSaving || !intakeText.trim()}>{intakeSaving ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />}{intakeSaving ? '正在添加并查询…' : '添加并立即查询'}</button></div>
        </section>
      </div>}

      {displaySettingsOpen && <div className="modal-backdrop settings-backdrop" role="presentation" onMouseDown={() => setDisplaySettingsOpen(false)}>
        <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="display-settings-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading"><div><p className="eyebrow">TABLE DISPLAY</p><h2 id="display-settings-title">显示设置</h2><p>这些选项会立即作用于当前追踪表格。</p></div><button className="drawer-close" aria-label="关闭" onClick={() => setDisplaySettingsOpen(false)}><X size={19} /></button></div>
          <label className="display-option"><span><strong>紧凑表格</strong><small>缩短行高，在一屏内显示更多记录</small></span><input type="checkbox" checked={denseTable} onChange={(event) => setDenseTable(event.target.checked)} /></label>
          <label className="display-option"><span><strong>显示备注列</strong><small>保留官网错误、来源和合并查询提示</small></span><input type="checkbox" checked={showNoteColumn} onChange={(event) => setShowNoteColumn(event.target.checked)} /></label>
          <label className="display-option"><span><strong>显示最后更新时间</strong><small>查看本次官网联调写回 Excel 的时间</small></span><input type="checkbox" checked={showUpdatedColumn} onChange={(event) => setShowUpdatedColumn(event.target.checked)} /></label>
          <label className="display-option display-select"><span><strong>每页记录数</strong><small>分页只影响表格显示，不改变 Excel 数据</small></span><select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}><option value={10}>10 条</option><option value={20}>20 条</option><option value={50}>50 条</option></select></label>
          <div className="modal-actions"><button className="primary-button" onClick={() => setDisplaySettingsOpen(false)}>完成</button></div>
        </section>
      </div>}

      {detail && <div className="drawer-backdrop" onClick={() => setDetail(null)}><aside className="detail-drawer" onClick={(event) => event.stopPropagation()}><button className="drawer-close" onClick={() => setDetail(null)}><X size={19} /></button><p className="eyebrow">SHIPMENT DETAIL</p><h2>单号追踪详情</h2><div className="drawer-carrier"><CarrierMark code={detail.carrierCode} /><div><strong>{detail.carrier}</strong><span>{detail.billNo}</span></div></div><div className="detail-grid"><DetailItem label="提单号" value={detail.billNo} /><DetailItem label="柜号" value={detail.containerNo || '—'} /><DetailItem label="查询进度" value={<ProgressBadge shipment={detail} />} /><DetailItem label="船只状态" value={<VesselStateBadge shipment={detail} />} /></div><div className="timeline"><TimelineItem label="到港时间 ATA / ETA" value={formatDateTime(detail.eta)} active={Boolean(detail.eta)} /><TimelineItem label="卸船时间" value={formatDateTime(detail.dischargeTime)} active={Boolean(detail.dischargeTime)} last /></div>{detail.note && <div className="detail-alert"><CircleAlert size={17} /><div><strong>查询备注</strong><span>{detail.note}</span></div></div>}<div className="drawer-meta">数据更新于 {formatDateTime(detail.lastUpdated)}</div></aside></div>}
      {toast && <div className="toast"><Check size={17} />{toast}</div>}
    </div>
  );
}

interface CarrierRuleView {
  prefix: string;
  code: string;
  name: string;
  removePrefix: boolean;
  queryMode: 'bill' | 'bill-and-container' | 'bill-then-container';
  url: string;
  integration: 'ready' | 'blocked' | 'limited' | 'error';
  integrationMessage: string;
}

interface FailedTrackingView {
  carrier: string;
  carrierCode: string;
  billNo: string;
  containerNo: string;
  category: '订单号验证失败' | '官网拒绝访问' | '验证码或风控' | '官网接口异常' | '解析失败' | '查询超时';
  reason: string;
  sourceUrl: string;
  evidencePath?: string;
}

interface RunView {
  id: string;
  reason: 'manual' | 'scheduled';
  startedAt: string;
  finishedAt: string;
  total: number;
  success: number;
  unfinished: number;
  failed: number;
  skipped: number;
  failedDetails: FailedTrackingView[];
  notification: 'sent' | 'skipped' | 'failed';
}

interface BackupView {
  name: string;
  size: number;
  createdAt: string;
  reason: string;
}

function fullDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

function ModulePage({ page, data, automation, syncing, onSync, onToggleAutomation, onCreateBackup, onRestoreBackup, onAutomationUpdated, onUpload, onToast, onOpenDetail }: {
  page: Exclude<PageId, 'overview'>;
  data: DashboardData | null;
  automation: AutomationStatus | null;
  syncing: boolean;
  onSync: () => Promise<void>;
  onToggleAutomation: (enabled: boolean) => Promise<void>;
  onCreateBackup: () => Promise<void>;
  onRestoreBackup: (name: string) => Promise<void>;
  onAutomationUpdated: (automation: AutomationStatus) => void;
  onUpload: () => void;
  onToast: (message: string) => void;
  onOpenDetail: (shipment: Shipment) => void;
}) {
  const [carrierRules, setCarrierRules] = useState<CarrierRuleView[]>([]);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [backups, setBackups] = useState<BackupView[]>([]);
  const [settingsView, setSettingsView] = useState<SettingsView | null>(null);
  const [webhookInput, setWebhookInput] = useState('');
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [webhookTesting, setWebhookTesting] = useState(false);
  const [browserSaving, setBrowserSaving] = useState(false);
  const [moduleLoading, setModuleLoading] = useState(false);

  async function refreshModuleData() {
    setModuleLoading(true);
    try {
      const requests: Promise<void>[] = [];
      if (page === 'sources') requests.push(apiRequest<{ carriers: CarrierRuleView[] }>('/api/carriers').then((payload) => setCarrierRules(payload.carriers || [])));
      if (page === 'automation' || page === 'exports') requests.push(apiRequest<{ runs: RunView[] }>('/api/automation/runs').then((payload) => setRuns(payload.runs || [])));
      if (page === 'exports') requests.push(apiRequest<{ backups: BackupView[] }>('/api/backups').then((payload) => setBackups(payload.backups || [])));
      if (page === 'settings') requests.push(apiRequest<SettingsView>('/api/automation/settings').then((payload) => { setSettingsView(payload); setWebhookInput(''); }));
      await Promise.all(requests);
    } catch {
      onToast('模块数据加载失败');
    } finally {
      setModuleLoading(false);
    }
  }

  useEffect(() => {
    refreshModuleData();
  }, [page]);

  async function saveWebhook() {
    setWebhookSaving(true);
    try {
      const payload = await apiRequest<{ settings: SettingsView; automation: AutomationStatus }>('/api/automation/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wechatWebhookUrl: webhookInput.trim() }),
      });
      setSettingsView(payload.settings);
      setWebhookInput('');
      onAutomationUpdated(payload.automation);
      onToast(payload.settings.notificationConfigured ? '企业微信配置已保存' : '企业微信配置已清除');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '企业微信配置保存失败');
    } finally {
      setWebhookSaving(false);
    }
  }

  async function testWebhook() {
    setWebhookTesting(true);
    try {
      await apiRequest('/api/automation/test-notification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wechatWebhookUrl: webhookInput.trim() || undefined }),
      });
      onToast('企业微信测试消息已发送');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '企业微信测试消息发送失败');
    } finally {
      setWebhookTesting(false);
    }
  }

  async function saveBrowserAutomation(enabled: boolean) {
    setBrowserSaving(true);
    try {
      const payload = await apiRequest<{ settings: SettingsView; automation: AutomationStatus }>('/api/automation/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ browserAutomationEnabled: enabled }),
      });
      setSettingsView(payload.settings);
      onAutomationUpdated(payload.automation);
      onToast(enabled ? '网页模拟点击已启用' : '网页模拟点击已停用');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '浏览器采集设置保存失败');
    } finally {
      setBrowserSaving(false);
    }
  }

  const pageInfo = {
    tracking: ['SHIPMENT TRACKING', '船期追踪', '按 Excel 字段查看全部单号的到港、卸船和查询进度。'],
    sources: ['DATA SOURCES', '数据源管理', '查看船司识别规则、查询方式和官网解析器接入状态。'],
    automation: ['AUTOMATION', '自动化任务', '管理定时计划、手动执行任务并查看历史运行结果。'],
    exports: ['EXPORTS & BACKUPS', '导出与备份', '下载当前工作簿，或恢复和查看每次更新前的自动备份。'],
    settings: ['SYSTEM SETTINGS', '系统设置', '检查服务运行模式、时区和企业微信通知配置。'],
  }[page];

  return <div className="module-page">
    <section className="page-heading module-heading">
      <div><p className="eyebrow">{pageInfo[0]}</p><h1>{pageInfo[1]}</h1><p>{pageInfo[2]}</p></div>
      {page === 'tracking' && <div className="heading-actions"><button className="secondary-button" onClick={onUpload}><Upload size={16} />导入 Excel</button><a className="primary-link-button" href="/api/workbooks/current"><Download size={16} />下载当前 Excel</a></div>}
      {page === 'automation' && <button className="primary-button" onClick={async () => { await onSync(); await refreshModuleData(); }} disabled={syncing}><RefreshCw size={16} className={syncing ? 'spin' : ''} />立即执行</button>}
    </section>

    {moduleLoading && <div className="module-loading"><LoaderCircle className="spin" />正在加载模块数据…</div>}

    {page === 'tracking' && <section className="module-card">
      <div className="module-card-header"><div><strong>全部追踪记录</strong><span>Excel 当前共 {data?.shipments.length || 0} 条</span></div><div className="compact-legend"><span className="legend-dot success" />已完成卸船<span className="legend-dot info" />等待卸船<span className="legend-dot muted-dot" />等待到港</div></div>
      <div className="module-table-wrap"><table className="module-table"><thead><tr><th>船司</th><th>提单号</th><th>柜号</th><th>到港时间</th><th>卸船时间</th><th>船只状态</th><th>进度</th><th>最后更新</th><th /></tr></thead><tbody>
        {(data?.shipments || []).map((item) => <tr key={item.id}><td><div className="carrier-cell"><CarrierMark code={item.carrierCode} /><div><strong>{item.carrier}</strong><span>{item.carrierCode}</span></div></div></td><td className="mono">{item.billNo}</td><td className="mono">{item.containerNo || '—'}</td><td><div className="date-cell eta">{formatDateTime(item.eta, true)}</div></td><td><div className="date-cell discharge">{formatDateTime(item.dischargeTime, true)}</div></td><td><VesselStateBadge shipment={item} /></td><td><ProgressBadge shipment={item} /></td><td>{timeAgo(item.lastUpdated)}</td><td><button className="row-action" onClick={() => onOpenDetail(item)}><ChevronRight size={17} /></button></td></tr>)}
      </tbody></table></div>
    </section>}

    {page === 'sources' && <section className="carrier-grid">
      {carrierRules.map((rule) => {
        const integrationLabel = { ready: '已接入', blocked: '浏览器仍受风控', limited: '浏览器备用已接入', error: '官网接口异常' }[rule.integration];
        return <article className="carrier-rule-card" key={`${rule.code}-${rule.name}`}><div className="carrier-rule-head"><CarrierMark code={rule.code} /><div><strong>{carrierLabel(rule.code, rule.name)}</strong><span>{rule.prefix} · {rule.code}</span></div><span className={`integration-tag ${rule.integration}`}>{integrationLabel}</span></div><dl><div><dt>查询号码</dt><dd>{rule.removePrefix ? `去除 ${rule.code === 'SMLINE' ? 'SMLM' : rule.prefix} 前缀` : '保留完整提单号'}</dd></div><div><dt>查询方式</dt><dd>{rule.queryMode === 'bill-and-container' ? '提单号 + 柜号双查' : rule.queryMode === 'bill-then-container' ? '提单失败后改查柜号' : '仅提单号'}</dd></div></dl><p className="integration-message">{rule.integrationMessage}</p><a href={rule.url} target="_blank" rel="noreferrer">打开船司查询页面<ExternalLink size={13} /></a></article>;
      })}
    </section>}

    {page === 'automation' && <>
      <section className="schedule-grid">
        {(automation?.schedule || []).map((schedule, index) => <article className="schedule-card" key={schedule.time}><div className="schedule-index">0{index + 1}</div><div><span>每日定时任务</span><strong>{schedule.time}</strong><small>Asia/Shanghai · {schedule.cron}</small></div><span className={`enabled-pill ${automation?.enabled ? '' : 'disabled'}`}>{automation?.enabled ? '已启用' : '已停用'}</span></article>)}
      </section>
      <section className="module-card automation-controls"><div><div className="control-icon"><FileSpreadsheet size={18} /></div><div><strong>官方接口 + 网页模拟点击</strong><span>接口失败后使用系统 Chrome 串行查询；页面数据无法核验时保存截图并记录原因</span></div></div><label className="setting-toggle"><span>{automation?.enabled ? '定时任务已启用' : '定时任务已停用'}</span><input type="checkbox" checked={Boolean(automation?.enabled)} onChange={(event) => onToggleAutomation(event.target.checked)} /><span className="switch-slider" /></label></section>
      <RunHistory runs={runs} />
    </>}

    {page === 'exports' && <>
      <section className="export-summary-grid"><article><FileCheck2 size={20} /><div><span>当前工作簿</span><strong>{automation?.workbook?.records || 0} 条记录</strong><small>{automation?.workbook ? fullDate(automation.workbook.modifiedAt) : '尚未导入'}</small></div><a href={automation?.workbook ? '/api/workbooks/current' : '#'} onClick={(event) => { if (!automation?.workbook) { event.preventDefault(); onToast('请先导入 Excel 或新增单号'); } }}>下载<Download size={14} /></a></article><article><Archive size={20} /><div><span>备份文件</span><strong>{backups.length} 个文件</strong><small>更新前自动生成，也可手动创建</small></div><button className="secondary-button backup-create" onClick={async () => { await onCreateBackup(); await refreshModuleData(); }} disabled={!automation?.workbook}>创建备份</button></article><article><FileSpreadsheet size={20} /><div><span>运行记录</span><strong>{runs.length} 次</strong><small>最多保留最近 30 次</small></div></article></section>
      <section className="module-card"><div className="module-card-header"><div><strong>备份文件</strong><span>按时间倒序排列，恢复前会再次自动备份当前文件</span></div></div><div className="backup-list">{backups.length ? backups.map((backup) => <div key={backup.name}><div className="backup-icon"><Archive size={17} /></div><div><strong>{backup.name}</strong><span>{backup.reason} · {(backup.size / 1024).toFixed(1)} KB · {fullDate(backup.createdAt)}</span></div><div className="backup-actions"><a href={`/api/backups/${encodeURIComponent(backup.name)}`}><Download size={15} />下载</a><button className="danger-button" onClick={async () => { await onRestoreBackup(backup.name); await refreshModuleData(); }} disabled={!automation?.workbook}>恢复</button></div></div>) : <div className="empty-module">尚无备份文件，执行一次更新或手动创建备份后会显示。</div>}</div></section>
    </>}

    {page === 'settings' && <section className="settings-grid">
      <article className="settings-card"><div className="settings-card-title"><Server size={19} /><div><strong>采集服务</strong><span>本地服务器运行状态</span></div><span className="setting-ok">运行中</span></div><div className="setting-row"><span>运行模式</span><strong>真实官网数据</strong></div><div className="setting-row"><span>支持船司规则</span><strong>{automation?.supportedCarriers || 15} 家</strong></div><div className="setting-row"><span>服务端口</span><strong>{window.location.port || '8787'}</strong></div></article>
      <article className="settings-card"><div className="settings-card-title"><Timer size={19} /><div><strong>计划任务</strong><span>仅在服务持续运行时执行</span></div><span className={automation?.enabled ? 'setting-ok' : 'setting-warn'}>{automation?.enabled ? '已启用' : '已停用'}</span></div><div className="setting-row"><span>定时任务开关</span><label className="setting-toggle"><span>{automation?.enabled ? '启用' : '停用'}</span><input type="checkbox" checked={Boolean(automation?.enabled)} onChange={(event) => onToggleAutomation(event.target.checked)} /><span className="switch-slider" /></label></div><div className="setting-row"><span>执行时区</span><strong>{automation?.timezone || 'Asia/Shanghai'}</strong></div><div className="setting-row"><span>执行时间</span><strong>{automation?.schedule.map((item) => item.time).join(' / ')}</strong></div><div className="setting-row"><span>查询范围</span><strong>未到港或未卸船</strong></div></article>
      <article className="settings-card"><div className="settings-card-title"><Globe2 size={19} /><div><strong>网页模拟点击</strong><span>官方接口失败后的自动备用通道</span></div><span className={settingsView?.browserAutomationEnabled ? 'setting-ok' : 'setting-warn'}>{settingsView?.browserAutomationEnabled ? '已启用' : '已停用'}</span></div><div className="setting-row"><span>浏览器备用查询</span><label className="setting-toggle"><span>{settingsView?.browserAutomationEnabled ? '启用' : '停用'}</span><input type="checkbox" checked={Boolean(settingsView?.browserAutomationEnabled)} disabled={browserSaving} onChange={(event) => saveBrowserAutomation(event.target.checked)} /><span className="switch-slider" /></label></div><div className="setting-row"><span>运行方式</span><strong>系统 Chrome · 无界面</strong></div><div className="setting-row"><span>并发策略</span><strong>单线程串行，降低风控</strong></div><div className="setting-help">页面必须同时显示对应提单号/柜号和明确时间字段才会写入；验证码、空页面或无法核验的数据仍按失败处理，并保存证据截图。</div></article>
      <article className="settings-card wecom-settings"><div className="settings-card-title"><MessageSquare size={19} /><div><strong>企业微信通知</strong><span>任务完成后发送汇总</span></div><span className={settingsView?.notificationConfigured || automation?.notificationConfigured ? 'setting-ok' : 'setting-warn'}>{settingsView?.notificationConfigured || automation?.notificationConfigured ? '已配置' : '待配置'}</span></div><div className="setting-help">可直接在这里保存企业微信机器人 Webhook。密钥只保存在本机服务端，不会回显完整地址。</div><label className="setting-field"><span>机器人 Webhook</span><input type="url" value={webhookInput} onChange={(event) => setWebhookInput(event.target.value)} placeholder={settingsView?.webhookPreview || 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'} /></label><div className="setting-preview">{settingsView?.notificationConfigured ? `当前配置：${settingsView.webhookPreview}` : '当前未配置企业微信通知'}</div><div className="setting-actions"><button className="secondary-button" onClick={testWebhook} disabled={webhookTesting || (!webhookInput.trim() && !settingsView?.notificationConfigured)}><Send size={15} />{webhookTesting ? '发送中…' : '发送测试'}</button><button className="primary-button" onClick={saveWebhook} disabled={webhookSaving}>{webhookSaving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{webhookSaving ? '保存中…' : '保存配置'}</button></div></article>
    </section>}
  </div>;
}

function RunHistory({ runs }: { runs: RunView[] }) {
  return <section className="module-card"><div className="module-card-header"><div><strong>任务运行记录</strong><span>最近 {runs.length} 次 · 失败记录包含船司、提单号、柜号、官网原因和浏览器证据</span></div></div><div className="run-list">{runs.length ? runs.map((run) => <article className="run-entry" key={run.id}><div className="run-summary"><span className={`run-state ${run.failed ? 'failed' : 'success'}`}>{run.failed ? <CircleAlert size={15} /> : <Check size={15} />}</span><div className="run-main"><strong>{run.reason === 'scheduled' ? '定时更新' : '手动更新'}</strong><span>{run.id} · {fullDate(run.finishedAt)}</span></div><div className="run-stats"><span>查询 <strong>{run.total}</strong></span><span>成功 <strong>{run.success}</strong></span><span>未完成 <strong>{run.unfinished}</strong></span><span className={run.failed ? 'danger-text' : ''}>失败 <strong>{run.failed}</strong></span></div><span className={`notify-state ${run.notification}`}>{run.notification === 'sent' ? '通知已发送' : run.notification === 'failed' ? '通知失败' : '未配置通知'}</span></div>{run.failedDetails?.length ? <div className="run-failures">{run.failedDetails.map((detail) => <div key={`${run.id}-${detail.billNo}-${detail.containerNo}`}><span className="failure-category">{detail.category}</span><strong>{detail.carrier} · {detail.billNo}</strong><span>柜号：{detail.containerNo || '未提供'}</span><p>{detail.reason}</p>{detail.evidencePath ? <a className="evidence-link" href={detail.evidencePath} target="_blank" rel="noreferrer">查看浏览器失败截图<ExternalLink size={12} /></a> : null}</div>)}</div> : null}</article>) : <div className="empty-module">尚无运行记录。</div>}</div></section>;
}

function MetricCard({ title, value, suffix, trend, icon, tone, alert = false }: { title: string; value: number; suffix: string; trend: string; icon: React.ReactNode; tone: string; alert?: boolean }) {
  return <article className={`metric-card ${alert ? 'alert-card' : ''}`}><div className={`metric-icon ${tone}`}>{icon}</div><span className="metric-title">{title}</span><div className="metric-value"><strong>{String(value).padStart(2, '0')}</strong><span>{suffix}</span></div><p><span className={`mini-dot ${tone}`} />{trend}</p></article>;
}

function SourcePill({ source }: { source: CarrierSource }) {
  return <div className="source-pill"><span className="source-color" style={{ background: source.color }} /><div><strong>{carrierLabel(source.code, source.name)}</strong><span>{source.recordCount} 条 · {source.status === 'online' ? '真实查询成功' : source.status === 'warning' ? '官网返回异常' : '等待本次真实查询'}</span></div><span className={`source-status ${source.status}`} /></div>;
}

function DetailItem({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="detail-item"><span>{label}</span><strong>{value}</strong></div>;
}

function TimelineItem({ label, value, active = false, last = false }: { label: string; value: React.ReactNode; active?: boolean; last?: boolean }) {
  return <div className={`timeline-item ${active ? 'active' : ''} ${last ? 'last' : ''}`}><span className="timeline-dot" /><div><span>{label}</span><strong>{value}</strong></div></div>;
}
