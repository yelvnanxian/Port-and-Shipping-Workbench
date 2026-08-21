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
  Pencil,
  RefreshCw,
  Save,
  Send,
  Server,
  Search,
  Settings,
  Ship,
  SlidersHorizontal,
  Timer,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { AutomationStatus, AutomationTask, CarrierSource, DashboardData, ManualMark, Shipment, ShipmentStatus } from './types';

type PageId = 'overview' | 'tracking' | 'sources' | 'automation' | 'exports' | 'settings';

interface SettingsView {
  enabled: boolean;
  browserAutomationEnabled: boolean;
  schedule: Array<{ time: string; cron: string }>;
  timezone: string;
  notificationConfigured: boolean;
  webhookPreview: string;
}

type AuthRole = 'admin' | 'user';
interface AuthSession {
  enabled: boolean;
  authenticated: boolean;
  csrfToken: string;
  user: { id: string; username: string; role: AuthRole } | null;
}

let csrfToken = '';

type RunSelection = { carrierCodes?: string[]; shipmentIds?: string[] };
type MetricKey = 'tracking' | 'arriving' | 'working' | 'completed' | 'changed';
type ShipmentDateField = 'eta' | 'dischargeTime' | 'lastUpdated';
type ShipmentSort = 'default' | 'asc' | 'desc';

interface ManualForm {
  mode: 'new' | 'edit';
  id?: string;
  billNo: string;
  containerNo: string;
  carrierHint: string;
  arrivalTime: string;
  dischargeTime: string;
  vesselState: NonNullable<Shipment['vesselState']>;
  note: string;
}

function manualInputTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.replace(' ', 'T').slice(0, 16);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
const manualMarkOptions: Array<{ value: ManualMark; label: string }> = [
  { value: '', label: '未标记' },
  { value: '已清关', label: '已清关' },
  { value: '查验中', label: '查验中' },
  { value: '其他', label: '其他' },
];

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

function summarizeNote(note?: string) {
  if (!note?.trim()) return '—';
  const concise = (value: string) => value.length > 58 ? `${value.slice(0, 58)}…` : value;
  const category = note.match(/(?:^|；)失败分类=([^；]+)/)?.[1];
  const reason = note.match(/(?:^|；)原因=([^；]+)/)?.[1];
  if (category || reason) return concise(`${category || '查询失败'}：${reason || '官网未返回可核验数据'}`);
  if (/人工补录|人工修改/.test(note)) return concise(note.split('；')[0]);
  const arrivalKind = note.match(/(?:^|；)到港字段=(ATA|ETA)/)?.[1];
  if (/已发现实际卸船事件|已发现卸船事件/.test(note)) return `已获取${arrivalKind ? ` ${arrivalKind}` : '到港时间'}和实际卸船时间`;
  if (arrivalKind) return `已获取 ${arrivalKind}，尚未发现实际卸船时间`;
  const firstSummary = note.split('；').find((part) => !/^(?:来源|成功证据|运行线路)=/.test(part.trim())) || note;
  return concise(firstSummary);
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

function shipmentTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  const matched = value.match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if (!matched) return null;
  const fallback = new Date(`${matched[1]}T${matched[2] || '00:00'}:00+08:00`);
  return Number.isNaN(fallback.getTime()) ? null : fallback.getTime();
}

function shipmentFieldTimestamp(shipment: Shipment, field: ShipmentDateField) {
  return shipmentTimestamp(shipment[field]);
}

function filterAndSortShipments(items: Shipment[], field: ShipmentDateField, dateFrom: string, dateTo: string, sort: ShipmentSort) {
  const from = dateFrom ? new Date(`${dateFrom}T00:00:00+08:00`).getTime() : null;
  const to = dateTo ? new Date(`${dateTo}T23:59:59+08:00`).getTime() : null;
  const filtered = items.filter((item) => {
    if (from === null && to === null) return true;
    const value = shipmentFieldTimestamp(item, field);
    return value !== null && (from === null || value >= from) && (to === null || value <= to);
  });
  if (sort === 'default') return filtered;
  return [...filtered].sort((left, right) => {
    const leftTime = shipmentFieldTimestamp(left, field);
    const rightTime = shipmentFieldTimestamp(right, field);
    if (leftTime === null && rightTime === null) return 0;
    if (leftTime === null) return 1;
    if (rightTime === null) return -1;
    return sort === 'asc' ? leftTime - rightTime : rightTime - leftTime;
  });
}

async function downloadShipmentList(shipments: Shipment[]) {
  if (!shipments.length) throw new Error('当前列表没有可导出的记录');
  const response = await fetch('/api/shipments/export', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
    body: JSON.stringify({ ids: shipments.map((item) => item.id) }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(payload?.message || `导出失败（HTTP ${response.status}）`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = '船期筛选结果.xlsx';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (csrfToken && !headers.has('x-csrf-token')) headers.set('x-csrf-token', csrfToken);
  const response = await fetch(url, { ...init, credentials: 'include', headers });
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

function VerificationActions({ shipment, compact = false }: { shipment: Shipment; compact?: boolean }) {
  if (!shipment.sourceUrl && !shipment.evidencePath) return <span className="empty-value">暂无来源</span>;
  const verificationNo = shipment.verificationNo || shipment.billNo;
  return <div className={compact ? 'verification-actions compact' : 'verification-actions'}>
    {shipment.evidencePath ? <a
      className={compact ? 'verification-link compact evidence' : 'verification-link evidence'}
      href={shipment.evidencePath}
      target="_blank"
      rel="noreferrer"
      title="查看本次自动查询成功后保存的页面截图"
    >
      {compact ? '采集证据' : '查看本次采集证据'}<ExternalLink size={compact ? 12 : 14} />
    </a> : null}
    {shipment.sourceUrl ? <a
      className={compact ? 'verification-link compact' : 'verification-link'}
      href={shipment.sourceUrl}
      target="_blank"
      rel="noreferrer"
      title={`打开船司官网；同时复制官网查询号 ${verificationNo}`}
      onClick={() => navigator.clipboard?.writeText(verificationNo).catch(() => undefined)}
    >
      {compact ? '官网复核' : '打开船司官网复核'}<ExternalLink size={compact ? 12 : 14} />
    </a> : null}
  </div>;
}

function LoginScreen({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try { await onLogin(username, password); } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); }
    finally { setSubmitting(false); }
  }
  return <main className="login-screen"><form className="login-card" onSubmit={submit}><div className="login-brand"><div className="avatar">A4</div><div><strong>Port Operations</strong><span>船期数据工作台</span></div></div><p className="eyebrow">SECURE ACCESS</p><h1>登录工作台</h1><p className="login-help">请输入账号密码后继续访问真实订单数据。</p><label className="setting-field"><span>用户名</span><input autoFocus value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label><label className="setting-field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>{error ? <div className="login-error"><CircleAlert size={15} />{error}</div> : null}<button className="primary-button login-submit" type="submit" disabled={submitting || !username.trim() || !password}>{submitting ? <LoaderCircle size={15} className="spin" /> : null}{submitting ? '登录中…' : '登录'}</button></form></main>;
}

export default function App() {
  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activePage, setActivePage] = useState<PageId>(() => {
    const page = window.location.hash.replace('#', '') as PageId;
    return pageTitles[page] ? page : 'overview';
  });
  const [data, setData] = useState<DashboardData | null>(null);
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pollingRun, setPollingRun] = useState(false);
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
  const [manualForm, setManualForm] = useState<ManualForm | null>(null);
  const [manualSaving, setManualSaving] = useState(false);
  const [moreFilterOpen, setMoreFilterOpen] = useState(false);
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [onlyException, setOnlyException] = useState(false);
  const [manualMarkFilter, setManualMarkFilter] = useState<'全部标记' | ManualMark>('全部标记');
  const [dateField, setDateField] = useState<ShipmentDateField>('eta');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [timeSort, setTimeSort] = useState<ShipmentSort>('default');
  const [metricView, setMetricView] = useState<MetricKey | null>(null);
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  const [denseTable, setDenseTable] = useState(false);
  const [showNoteColumn, setShowNoteColumn] = useState(true);
  const [showUpdatedColumn, setShowUpdatedColumn] = useState(true);
  const [pageSize, setPageSize] = useState(20);
  const [pageNumber, setPageNumber] = useState(1);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const moreFilterRef = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const runRequestPending = useRef(false);

  async function refreshSession() {
    const response = await fetch('/api/auth/session', { credentials: 'include' });
    const payload = await response.json() as AuthSession;
    csrfToken = payload.csrfToken || '';
    setAuth(payload);
    return payload;
  }

  async function login(username: string, password: string) {
    const payload = await apiRequest<AuthSession>('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    csrfToken = payload.csrfToken || '';
    setAuth(payload);
  }

  async function logout() {
    await apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    csrfToken = '';
    setAuth((previous) => previous ? { ...previous, authenticated: false, user: null, csrfToken: '' } : previous);
  }

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
    refreshSession().then((session) => {
      if (!session.enabled || session.authenticated) return Promise.all([load(), loadAutomation()]);
      return undefined;
    }).catch((error) => setToast(error.message)).finally(() => { setAuthLoading(false); setLoading(false); });
  }, []);

  if (authLoading) return <main className="login-screen"><div className="login-card login-loading"><LoaderCircle size={24} className="spin" /><span>正在检查登录状态…</span></div></main>;
  if (auth?.enabled && !auth.authenticated) return <LoginScreen onLogin={login} />;

  useEffect(() => {
    if (automation?.running) {
      setSyncing(true);
      setPollingRun(true);
    }
  }, [automation?.running]);

  useEffect(() => {
    if (!pollingRun) return;
    let disposed = false;
    const poll = async () => {
      try {
        const next = await apiRequest<AutomationStatus>('/api/automation');
        if (!disposed) {
          setAutomation(next);
          if (!next.running && !runRequestPending.current) {
            setSyncing(false);
            setPollingRun(false);
            await Promise.all([load(), loadAutomation()]).catch(() => undefined);
          }
        }
      } catch {
        // The run request remains authoritative; a transient polling error should not stop it.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pollingRun]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const normalized = query.trim().toLowerCase();
    const matches = data.shipments.filter((item) => {
      const matchesQuery = !normalized || [item.billNo, item.containerNo, item.carrier, item.carrierCode]
        .some((field) => field.toLowerCase().includes(normalized));
      const matchesCarrier = carrier === '全部船司' || item.carrierCode === carrier;
      const matchesStatus = status === '全部状态' || item.status === status;
      const matchesIncomplete = !onlyIncomplete || item.vesselState !== '已到港已卸船';
      const matchesException = !onlyException || item.status === '计划变更' || item.progress === '失败';
      const matchesMark = manualMarkFilter === '全部标记' || item.manualMark === manualMarkFilter;
      return matchesQuery && matchesCarrier && matchesStatus && matchesIncomplete && matchesException && matchesMark;
    });
    return filterAndSortShipments(matches, dateField, dateFrom, dateTo, timeSort);
  }, [data, query, carrier, status, onlyIncomplete, onlyException, manualMarkFilter, dateField, dateFrom, dateTo, timeSort]);

  useEffect(() => {
    setPageNumber(1);
  }, [query, carrier, status, onlyIncomplete, onlyException, manualMarkFilter, dateField, dateFrom, dateTo, timeSort, pageSize]);

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      if (moreFilterRef.current && !moreFilterRef.current.contains(event.target as Node)) setMoreFilterOpen(false);
    };
    document.addEventListener('mousedown', closeMenu);
    return () => document.removeEventListener('mousedown', closeMenu);
  }, []);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleRows = filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);

  const metricLists = useMemo(() => {
    const records = data?.shipments || [];
    const now = Date.now();
    return {
      tracking: records.filter((item) => item.manualMark !== '已清关'),
      arriving: records.filter((item) => {
        const eta = shipmentTimestamp(item.eta);
        return item.manualMark !== '已清关' && item.status === '待靠泊' && eta !== null && eta >= now && eta <= now + 48 * 60 * 60 * 1000;
      }),
      working: records.filter((item) => item.manualMark !== '已清关' && item.status === '作业中'),
      completed: records.filter((item) => item.status === '已卸船'),
      changed: records.filter((item) => item.manualMark !== '已清关' && item.status === '计划变更'),
    };
  }, [data]);

  const metrics = {
    total: metricLists.tracking.length,
    arriving: metricLists.arriving.length,
    working: metricLists.working.length,
    completed: metricLists.completed.length,
    changed: metricLists.changed.length,
  };

  async function handleSync(selection?: RunSelection) {
    setSyncing(true);
    setPollingRun(true);
    runRequestPending.current = true;
    try {
      if (!automation?.workbook) throw new Error('请先导入 Excel 或新增单号');
      const payload = await apiRequest<{ run: { total: number; success: number; failed: number; skipped: number }; dashboard: DashboardData; automation: AutomationStatus }>('/api/automation/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(selection || {}),
      });
      setData(payload.dashboard);
      setAutomation(payload.automation);
      setToast(`本次查询 ${payload.run.total} 条：成功 ${payload.run.success} 条，失败 ${payload.run.failed} 条，跳过 ${payload.run.skipped} 条`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : '同步失败');
    } finally {
      runRequestPending.current = false;
      setPollingRun(false);
      setSyncing(false);
    }
  }

  async function handleSelectedSync() {
    if (!selected.size) {
      setToast('请先勾选要更新的船期');
      return;
    }
    await handleSync({ shipmentIds: [...selected] });
  }

  async function handleManualMark(id: string, manualMark: ManualMark) {
    try {
      const payload = await apiRequest<{ dashboard: DashboardData; automation: AutomationStatus }>(`/api/shipments/${encodeURIComponent(id)}/mark`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manualMark }),
      });
      setData(payload.dashboard);
      setAutomation(payload.automation);
      setDetail((current) => current?.id === id ? payload.dashboard.shipments.find((item) => item.id === id) || null : current);
      setToast(manualMark === '已清关' ? '已标记清关，后续自动任务将跳过该柜' : manualMark ? `已标记为${manualMark}` : '已清除人工标记');
    } catch (error) {
      setToast(error instanceof Error ? error.message : '人工标记保存失败');
    }
  }

  async function handleDeleteShipments(ids: string[]) {
    if (!ids.length) return;
    if (!window.confirm(`确认永久删除选中的 ${ids.length} 条船期记录？删除前会自动备份 Excel。`)) return;
    try {
      const payload = await apiRequest<{ deleted: number; dashboard: DashboardData; automation: AutomationStatus }>('/api/shipments/delete-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      setData(payload.dashboard);
      setAutomation(payload.automation);
      setSelected((previous) => new Set([...previous].filter((id) => !ids.includes(id))));
      setDetail((current) => current && ids.includes(current.id) ? null : current);
      setToast(`已删除 ${payload.deleted} 条记录，删除前文件已备份`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : '删除船期记录失败');
    }
  }

  async function handleListExport(shipments: Shipment[]) {
    try {
      await downloadShipmentList(shipments);
      setToast(`已导出当前列表 ${shipments.length} 条记录`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : '列表导出失败');
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
      const payload = await apiRequest<{ added: Array<{ rowNumber: number }>; duplicates: unknown[]; dashboard: DashboardData; automation: AutomationStatus }>('/api/intake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries }) });
      let completed = 0;
      if (payload.added.length) {
        setSyncing(true);
        setPollingRun(true);
        runRequestPending.current = true;
        const shipmentIds = payload.added.map((record) => `XLSX-${record.rowNumber}`);
        const runPayload = await apiRequest<{ run: { success: number }; dashboard: DashboardData; automation: AutomationStatus }>('/api/automation/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shipmentIds }),
        });
        completed = runPayload.run.success;
        setData(runPayload.dashboard);
        setAutomation(runPayload.automation);
      } else {
        setData(payload.dashboard);
        setAutomation(payload.automation);
      }
      setIntakeText('');
      setIntakeOpen(false);
      setToast(`已加入 ${payload.added.length} 条，重复 ${payload.duplicates.length} 条；仅查询新增记录，完成 ${completed} 条`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : '单号添加失败');
    } finally {
      runRequestPending.current = false;
      setPollingRun(false);
      setSyncing(false);
      setIntakeSaving(false);
    }
  }

  function openManualNew() {
    setManualForm({ mode: 'new', billNo: '', containerNo: '', carrierHint: '', arrivalTime: '', dischargeTime: '', vesselState: '未到港未卸船', note: '' });
  }

  function openManualEdit(shipment: Shipment) {
    setManualForm({ mode: 'edit', id: shipment.id, billNo: shipment.billNo, containerNo: shipment.containerNo, carrierHint: shipment.carrier, arrivalTime: manualInputTime(shipment.eta), dischargeTime: manualInputTime(shipment.dischargeTime), vesselState: shipment.vesselState || '未到港未卸船', note: '' });
  }

  async function saveManualForm() {
    if (!manualForm) return;
    if (!manualForm.billNo.trim()) {
      setToast('提单号不能为空');
      return;
    }
    setManualSaving(true);
    try {
      const payload = manualForm.mode === 'new'
        ? await apiRequest<{ dashboard: DashboardData; automation: AutomationStatus }>('/api/shipments/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manualForm) })
        : await apiRequest<{ dashboard: DashboardData; automation: AutomationStatus }>(`/api/shipments/${encodeURIComponent(manualForm.id || '')}/manual`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manualForm) });
      setData(payload.dashboard);
      setAutomation(payload.automation);
      setManualForm(null);
      setDetail(null);
      setToast(manualForm.mode === 'new' ? '人工补录已保存到 Excel' : '人工修改已保存到 Excel');
    } catch (error) {
      setToast(error instanceof Error ? error.message : '人工补录保存失败');
    } finally {
      setManualSaving(false);
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
  const successfulSources = data?.sources.filter((source) => source.status === 'online').length || 0;

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
            <button className="user-card" onClick={() => navigate('settings')}><div className="avatar">A4</div><div><strong>{auth?.user?.username || 'A4专用版'}</strong><span>{auth?.user?.role === 'user' ? '普通用户' : '工作台管理员'} · 打开系统设置</span></div></button>
            <button className="user-menu-button" aria-label="打开工作台菜单" title="工作台菜单" onClick={() => setProfileMenuOpen((value) => !value)}><MoreHorizontal size={17} /></button>
            {profileMenuOpen && <div className="user-menu"><button onClick={() => navigate('settings')}><Settings size={14} />系统设置</button><button onClick={() => { setProfileMenuOpen(false); window.location.reload(); }}><RefreshCw size={14} />重新加载</button>{auth?.enabled ? <button onClick={() => { setProfileMenuOpen(false); void logout(); }}><X size={14} />退出登录</button> : null}</div>}
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
          {(syncing || automation?.running) && automation?.currentRun && <SyncProgress progress={automation.currentRun} />}
          <div className={activePage === 'overview' ? '' : 'hidden-page'}>
          <section className="page-heading">
            <div><p className="eyebrow">OPERATIONS OVERVIEW</p><h1>运营总览</h1><p>集中追踪船期、靠泊与卸船动态，及时掌握异常变化。</p></div>
            <div className="heading-actions"><button className="secondary-button add-record-button" onClick={() => setIntakeOpen(true)}><Ship size={17} />新增单号</button><button className="secondary-button" onClick={openManualNew}><Pencil size={16} />人工补录</button>{selected.size > 0 && <><button className="secondary-button" onClick={handleSelectedSync} disabled={syncing}><RefreshCw size={17} className={syncing ? 'spin' : ''} />更新已选 ({selected.size})</button><button className="danger-button" onClick={() => handleDeleteShipments([...selected])} disabled={syncing}><Trash2 size={15} />删除已选</button></>}<button className="secondary-button" onClick={handleExport}><Download size={17} />导出 Excel</button><button className="primary-button" onClick={() => handleSync()} disabled={syncing}><RefreshCw size={17} className={syncing ? 'spin' : ''} />{syncing ? '同步中…' : '同步最新数据'}</button></div>
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
            <MetricCard title="追踪中的货物" value={metrics.total} suffix="票" trend={`覆盖 ${data?.sources.length || 0} 家船司`} icon={<Ship size={20} />} tone="navy" onClick={() => setMetricView('tracking')} />
            <MetricCard title="未来 48h 到港" value={metrics.arriving} suffix="票" trend="需要持续关注" icon={<Clock3 size={20} />} tone="teal" onClick={() => setMetricView('arriving')} />
            <MetricCard title="正在码头作业" value={metrics.working} suffix="票" trend="卸船作业进行中" icon={<Anchor size={20} />} tone="blue" onClick={() => setMetricView('working')} />
            <MetricCard title="已完成卸船" value={metrics.completed} suffix="票" trend="后续不再重复查询" icon={<Check size={20} />} tone="green" onClick={() => setMetricView('completed')} />
            <MetricCard title="计划有变更" value={metrics.changed} suffix="票" trend="建议优先处理" icon={<CircleAlert size={20} />} tone="orange" alert onClick={() => setMetricView('changed')} />
          </section>

          <section className="source-strip">
            <div className="source-title"><div className="source-icon"><Database size={19} /></div><div><strong>数据源状态</strong><span>当前 Excel 累计 {successfulSources} 家成功{automation?.lastRun ? ` · 最近一次：查询 ${automation.lastRun.total} 条，成功 ${automation.lastRun.success}、失败 ${automation.lastRun.failed}、跳过 ${automation.lastRun.skipped}` : ''}</span></div></div>
            <div className="source-list">
              {(data?.sources || []).map((source) => <SourcePill key={source.id} source={source} />)}
            </div>
            <button className="manage-link" onClick={() => navigate('sources')}>管理数据源<ChevronRight size={15} /></button>
          </section>

          <section className={`table-card ${denseTable ? 'compact-table' : ''}`}>
            <div className="table-header">
              <div><h2>船期追踪</h2><span>共 {filtered.length} 条记录 · 勾选后可只更新指定船期</span></div>
              <div className="table-header-actions">{selected.size > 0 && <><button className="view-settings" onClick={handleSelectedSync} disabled={syncing}><RefreshCw size={15} />更新已选</button><button className="view-settings danger-action" onClick={() => handleDeleteShipments([...selected])} disabled={syncing}><Trash2 size={14} />删除已选</button></>}<button className="view-settings" onClick={() => setDisplaySettingsOpen(true)}><SlidersHorizontal size={16} />显示设置</button></div>
            </div>
            <div className="filters-row">
              <label className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提单号、柜号或船司" />{query && <button onClick={() => setQuery('')}><X size={14} /></button>}</label>
              <div className="select-wrap"><select value={carrier} onChange={(event) => setCarrier(event.target.value)}><option value="全部船司">全部船司</option>{carriers.map((item) => <option key={item} value={item}>{carrierLabel(item)}</option>)}</select><ChevronDown size={15} /></div>
              <div className="select-wrap"><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>{statusOptions.map((item) => <option key={item}>{item}</option>)}</select><ChevronDown size={15} /></div>
              <div className="more-filter-wrap" ref={moreFilterRef}><button className={`filter-button ${onlyIncomplete || onlyException || manualMarkFilter !== '全部标记' || dateFrom || dateTo || timeSort !== 'default' ? 'filter-active' : ''}`} onClick={(event) => { event.stopPropagation(); setMoreFilterOpen((value) => !value); }}><Filter size={16} />更多筛选</button>{moreFilterOpen && <div className="more-filter-menu advanced-filter-menu" onClick={(event) => event.stopPropagation()}><strong>高级筛选与排序</strong><label><input type="checkbox" checked={onlyIncomplete} onChange={(event) => setOnlyIncomplete(event.target.checked)} />只看未完成记录</label><label><input type="checkbox" checked={onlyException} onChange={(event) => setOnlyException(event.target.checked)} />只看失败或异常</label><span className="filter-field-label">人工标记</span><select value={manualMarkFilter} onChange={(event) => setManualMarkFilter(event.target.value as typeof manualMarkFilter)}><option value="全部标记">全部标记</option>{manualMarkOptions.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}</select><span className="filter-field-label">日期字段</span><select value={dateField} onChange={(event) => setDateField(event.target.value as ShipmentDateField)}><option value="eta">到港时间</option><option value="dischargeTime">卸船时间</option><option value="lastUpdated">最后更新时间</option></select><div className="date-filter-grid"><label><span>开始日期</span><input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label><span>结束日期</span><input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div><span className="filter-field-label">时间排序</span><select value={timeSort} onChange={(event) => setTimeSort(event.target.value as ShipmentSort)}><option value="default">默认顺序</option><option value="asc">时间从早到晚</option><option value="desc">时间从晚到早</option></select><button onClick={() => { setOnlyIncomplete(false); setOnlyException(false); setManualMarkFilter('全部标记'); setDateFrom(''); setDateTo(''); setTimeSort('default'); setMoreFilterOpen(false); }}>重置高级筛选</button></div>}</div>
              {(query || carrier !== '全部船司' || status !== '全部状态' || onlyIncomplete || onlyException || manualMarkFilter !== '全部标记' || dateFrom || dateTo || timeSort !== 'default') && <button className="clear-filter" onClick={() => { setQuery(''); setCarrier('全部船司'); setStatus('全部状态'); setOnlyIncomplete(false); setOnlyException(false); setManualMarkFilter('全部标记'); setDateFrom(''); setDateTo(''); setTimeSort('default'); }}>清除筛选</button>}
            </div>

            <div className="table-scroll">
              <table>
                <thead><tr>
                  <th className="check-col"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                  <th>船司</th><th>到港时间<br/><span>ATA / ETA</span></th><th>提单号</th><th>柜号</th><th>卸船时间</th><th>船只状态</th><th>人工标记</th>{showUpdatedColumn && <th>最后更新时间</th>}{showNoteColumn && <th>备注</th>}<th>进度</th><th />
                </tr></thead>
                <tbody>
                  {loading ? <tr><td colSpan={12}><div className="loading-state"><LoaderCircle className="spin" />正在汇总船司数据…</div></td></tr> : filtered.length === 0 ? <tr><td colSpan={12}><div className="empty-state"><Search size={24} /><strong>没有匹配的船期记录</strong><span>调整关键词或筛选条件后再试</span></div></td></tr> : visibleRows.map((item) => (
                    <tr key={item.id} className={`${selected.has(item.id) ? 'selected-row' : ''} ${item.manualMark === '已清关' ? 'cleared-row' : ''}`}>
                      <td className="check-col"><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleOne(item.id)} /></td>
                      <td><div className="carrier-cell"><CarrierMark code={item.carrierCode} /><div><strong>{carrierLabel(item.carrierCode, item.carrier)}</strong><span>{item.carrierCode}</span></div></div></td>
                      <td><div className="date-cell eta">{formatDateTime(item.eta, true)}</div></td>
                      <td><strong className="mono">{item.billNo}</strong></td>
                      <td><strong className="mono muted-strong">{item.containerNo || '—'}</strong></td>
                      <td><div className="date-cell discharge">{formatDateTime(item.dischargeTime, true)}</div></td>
                      <td><VesselStateBadge shipment={item} /></td>
                      <td><ManualMarkSelect value={item.manualMark} onChange={(value) => handleManualMark(item.id, value)} disabled={syncing} /></td>
                      {showUpdatedColumn && <td><div className="update-cell"><span>{timeAgo(item.lastUpdated)}</span><small>{formatDateTime(item.lastUpdated)}</small></div></td>}
                      {showNoteColumn && <td><span className="note-cell" title={item.note}>{summarizeNote(item.note)}</span></td>}
                      <td><ProgressBadge shipment={item} /></td>
                      <td><div className="row-actions"><button className="row-action" title="人工修改时间与状态" onClick={() => openManualEdit(item)}><Pencil size={14} /></button><button className="row-action" title="只更新这一条" onClick={() => handleSync({ shipmentIds: [item.id] })} disabled={syncing || item.manualMark === '已清关'}><RefreshCw size={14} /></button><button className="row-action danger-action" title="删除这条记录" onClick={() => handleDeleteShipments([item.id])} disabled={syncing}><Trash2 size={14} /></button><button className="row-action" title="查看详情" onClick={() => setDetail(item)}><ChevronRight size={17} /></button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-footer"><span>当前显示 {visibleRows.length} / {filtered.length} 条 · 已选择 {selected.size} 条</span><div><span>每页 {pageSize} 条</span><button disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => Math.max(1, value - 1))}>上一页</button>{Array.from({ length: pageCount }, (_, index) => index + 1).slice(Math.max(0, pageNumber - 3), pageNumber + 2).map((number) => <button key={number} className={number === pageNumber ? 'page-active' : ''} onClick={() => setPageNumber(number)}>{number}</button>)}<button disabled={pageNumber >= pageCount} onClick={() => setPageNumber((value) => Math.min(pageCount, value + 1))}>下一页</button></div></div>
          </section>
          <p className="legal-note">数据仅用于运营辅助，最终船期以船司及码头官方信息为准。</p>
          </div>
          {activePage !== 'overview' && <ModulePage page={activePage} data={data} automation={automation} syncing={syncing} onSync={handleSync} onMark={handleManualMark} onDelete={handleDeleteShipments} onToggleAutomation={handleToggleAutomation} onCreateBackup={handleCreateBackup} onRestoreBackup={handleRestoreBackup} onAutomationUpdated={setAutomation} onUpload={() => uploadInput.current?.click()} onToast={setToast} onOpenDetail={setDetail} onOpenEdit={openManualEdit} onOpenManual={openManualNew} />}
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

      {metricView && <MetricListModal metricKey={metricView} shipments={metricLists[metricView]} syncing={syncing} onClose={() => setMetricView(null)} onExport={handleListExport} onMark={handleManualMark} onSync={(ids) => handleSync({ shipmentIds: ids })} onDelete={handleDeleteShipments} onEdit={openManualEdit} onDetail={setDetail} />}
      {detail && <div className="drawer-backdrop" onClick={() => setDetail(null)}><aside className="detail-drawer" onClick={(event) => event.stopPropagation()}><button className="drawer-close" onClick={() => setDetail(null)}><X size={19} /></button><p className="eyebrow">SHIPMENT DETAIL</p><h2>单号追踪详情</h2><div className="drawer-carrier"><CarrierMark code={detail.carrierCode} /><div><strong>{detail.carrier}</strong><span>{detail.billNo}</span></div></div><div className="detail-grid"><DetailItem label="提单号" value={detail.billNo} /><DetailItem label="官网查询号" value={detail.verificationNo || detail.billNo} /><DetailItem label="柜号" value={detail.containerNo || '—'} /><DetailItem label="查询进度" value={<ProgressBadge shipment={detail} />} /><DetailItem label="船只状态" value={<VesselStateBadge shipment={detail} />} /><DetailItem label="人工标记" value={<ManualMarkSelect value={detail.manualMark} onChange={(value) => handleManualMark(detail.id, value)} disabled={syncing} />} /></div><div className="timeline"><TimelineItem label="到港时间 ATA / ETA" value={formatDateTime(detail.eta)} active={Boolean(detail.eta)} /><TimelineItem label="卸船时间" value={formatDateTime(detail.dischargeTime)} active={Boolean(detail.dischargeTime)} last /></div>{detail.route && <div className="route-card"><Ship size={17} /><div><strong>官网运行线路</strong><span>{detail.route}</span></div></div>}{detail.note && <div className="detail-alert"><CircleAlert size={17} /><div><strong>查询备注</strong><span>{detail.note}</span></div></div>}<div className="verification-card"><div><Globe2 size={17} /><div><strong>官网真实性核验</strong><span>官网复核会复制船司实际接受的查询号；森罗会自动去除 SMLM 前缀。部分官网会要求重新查询或接受 Cookie。</span></div></div><VerificationActions shipment={detail} /></div><div className="drawer-actions"><button className="secondary-button" onClick={() => openManualEdit(detail)}><Pencil size={15} />人工修改时间与状态</button></div><div className="drawer-meta">数据更新于 {formatDateTime(detail.lastUpdated)}</div></aside></div>}
      {manualForm && <ManualFormModal form={manualForm} saving={manualSaving} onChange={setManualForm} onClose={() => !manualSaving && setManualForm(null)} onSave={saveManualForm} />}
      {toast && <div className="toast"><Check size={17} />{toast}</div>}
    </div>
  );
}

interface CarrierRuleView {
  prefix: string;
  code: string;
  name: string;
  removePrefix: boolean;
  queryMode: 'bill' | 'bill-and-container' | 'bill-then-container' | 'bill-or-container';
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

function ModulePage({ page, data, automation, syncing, onSync, onMark, onDelete, onToggleAutomation, onCreateBackup, onRestoreBackup, onAutomationUpdated, onUpload, onToast, onOpenDetail, onOpenEdit, onOpenManual }: {
  page: Exclude<PageId, 'overview'>;
  data: DashboardData | null;
  automation: AutomationStatus | null;
  syncing: boolean;
  onSync: (selection?: RunSelection) => Promise<void>;
  onMark: (id: string, manualMark: ManualMark) => Promise<void>;
  onDelete: (ids: string[]) => Promise<void>;
  onToggleAutomation: (enabled: boolean) => Promise<void>;
  onCreateBackup: () => Promise<void>;
  onRestoreBackup: (name: string) => Promise<void>;
  onAutomationUpdated: (automation: AutomationStatus) => void;
  onUpload: () => void;
  onToast: (message: string) => void;
  onOpenDetail: (shipment: Shipment) => void;
  onOpenEdit: (shipment: Shipment) => void;
  onOpenManual: () => void;
}) {
  const [carrierRules, setCarrierRules] = useState<CarrierRuleView[]>([]);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [backups, setBackups] = useState<BackupView[]>([]);
  const [settingsView, setSettingsView] = useState<SettingsView | null>(null);
  const [webhookInput, setWebhookInput] = useState('');
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [webhookTesting, setWebhookTesting] = useState(false);
  const [browserSaving, setBrowserSaving] = useState(false);
  const [deletingBackup, setDeletingBackup] = useState('');
  const [selectedBackups, setSelectedBackups] = useState<Set<string>>(new Set());
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set());
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskName, setTaskName] = useState('');
  const [taskScheduleTime, setTaskScheduleTime] = useState('');
  const [taskScope, setTaskScope] = useState<AutomationTask['scope']>('all');
  const [taskCarrierCodes, setTaskCarrierCodes] = useState<string[]>([]);
  const [taskShipmentIds, setTaskShipmentIds] = useState<string[]>([]);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskRunning, setTaskRunning] = useState(false);
  const [deletingTask, setDeletingTask] = useState('');
  const [moduleLoading, setModuleLoading] = useState(false);
  const [selectedShipments, setSelectedShipments] = useState<Set<string>>(new Set());

  async function refreshModuleData() {
    setModuleLoading(true);
    try {
      const requests: Promise<void>[] = [];
      if (page === 'sources') requests.push(apiRequest<{ carriers: CarrierRuleView[] }>('/api/carriers').then((payload) => setCarrierRules(payload.carriers || [])));
      if (page === 'automation' || page === 'exports') requests.push(apiRequest<{ runs: RunView[] }>('/api/automation/runs').then((payload) => setRuns(payload.runs || [])));
      if (page === 'automation') requests.push(apiRequest<{ tasks: AutomationTask[] }>('/api/automation/tasks').then((payload) => setTasks(payload.tasks || [])));
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

  useEffect(() => {
    const existing = new Set((data?.shipments || []).map((shipment) => shipment.id));
    setSelectedShipments((previous) => new Set([...previous].filter((id) => existing.has(id))));
  }, [data]);

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

  async function deleteBackup(name: string) {
    if (!window.confirm(`确认永久删除备份 ${name}？删除后无法恢复。`)) return;
    setDeletingBackup(name);
    try {
      const payload = await apiRequest<{ backups: BackupView[] }>('/api/backups/delete-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names: [name] }) });
      setBackups(payload.backups || []);
      setSelectedBackups((previous) => { const next = new Set(previous); next.delete(name); return next; });
      onToast('备份文件已删除');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '删除备份失败');
    } finally {
      setDeletingBackup('');
    }
  }

  function toggleBackup(name: string) {
    setSelectedBackups((previous) => {
      const next = new Set(previous);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  async function deleteSelectedBackups() {
    if (!selectedBackups.size) return;
    if (!window.confirm(`确认永久删除选中的 ${selectedBackups.size} 个备份？删除后无法恢复。`)) return;
    setDeletingBackup('batch');
    try {
      const payload = await apiRequest<{ backups: BackupView[] }>('/api/backups/delete-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names: [...selectedBackups] }) });
      setBackups(payload.backups || []);
      setSelectedBackups(new Set());
      onToast('选中的备份文件已删除');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '批量删除备份失败');
    } finally {
      setDeletingBackup('');
    }
  }

  function toggleTask(id: string) {
    setSelectedTasks((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleRun(id: string) {
    setSelectedRuns((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function createTask() {
    if (!taskName.trim()) {
      onToast('请填写任务名称');
      return;
    }
    setTaskSaving(true);
    try {
      const payload = await apiRequest<{ tasks: AutomationTask[] }>('/api/automation/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: taskName, scope: taskScope, carrierCodes: taskCarrierCodes, shipmentIds: taskShipmentIds, scheduleTime: taskScheduleTime || null }),
      });
      setTasks(payload.tasks || []);
      setTaskName('');
      setTaskScheduleTime('');
      setTaskScope('all');
      setTaskCarrierCodes([]);
      setTaskShipmentIds([]);
      setTaskModalOpen(false);
      onToast('自定义任务已创建，可按顺序执行');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '创建任务失败');
    } finally {
      setTaskSaving(false);
    }
  }

  async function deleteSelectedTasks() {
    if (!selectedTasks.size) return;
    if (!window.confirm(`确认删除选中的 ${selectedTasks.size} 条自动化任务？`)) return;
    try {
      const payload = await apiRequest<{ tasks: AutomationTask[] }>('/api/automation/tasks/delete-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [...selectedTasks] }) });
      setTasks(payload.tasks || []);
      setSelectedTasks(new Set());
      onToast('选中的自动化任务已删除');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '删除任务失败');
    }
  }

  async function runSelectedTasks() {
    if (!selectedTasks.size) {
      onToast('请先选择要执行的任务');
      return;
    }
    setTaskRunning(true);
    try {
      const orderedTaskIds = tasks.filter((task) => selectedTasks.has(task.id)).map((task) => task.id);
      const payload = await apiRequest<{ runs: RunView[]; tasks: AutomationTask[]; dashboard: DashboardData; automation: AutomationStatus }>('/api/automation/tasks/run-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: orderedTaskIds }) });
      setTasks(payload.tasks || []);
      onToast(`已按选择顺序完成 ${payload.runs.length} 条任务`);
      await refreshModuleData();
    } catch (error) {
      onToast(error instanceof Error ? error.message : '执行任务失败');
    } finally {
      setTaskRunning(false);
    }
  }

  async function runTask(task: AutomationTask) {
    setTaskRunning(true);
    try {
      const payload = await apiRequest<{ tasks: AutomationTask[]; dashboard: DashboardData; automation: AutomationStatus }>(`/api/automation/tasks/${encodeURIComponent(task.id)}/run`, { method: 'POST' });
      setTasks(payload.tasks || []);
      onToast(`任务“${task.name}”已完成`);
      await refreshModuleData();
    } catch (error) {
      onToast(error instanceof Error ? error.message : '执行任务失败');
    } finally {
      setTaskRunning(false);
    }
  }

  async function deleteRun(id: string) {
    if (!window.confirm('确认删除这条运行记录？删除后无法恢复。')) return;
    try {
      const payload = await apiRequest<{ runs: RunView[] }>('/api/automation/runs/delete-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
      setRuns(payload.runs || []);
      setSelectedRuns((previous) => { const next = new Set(previous); next.delete(id); return next; });
      onToast('运行记录已删除');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '删除运行记录失败');
    }
  }

  async function deleteSelectedRuns() {
    if (!selectedRuns.size) return;
    if (!window.confirm(`确认删除选中的 ${selectedRuns.size} 条运行记录？`)) return;
    try {
      const payload = await apiRequest<{ runs: RunView[] }>('/api/automation/runs/delete-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [...selectedRuns] }) });
      setRuns(payload.runs || []);
      setSelectedRuns(new Set());
      onToast('选中的运行记录已删除');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '删除运行记录失败');
    }
  }

  async function syncCarrier(code: string) {
    await onSync({ carrierCodes: [code] });
    await refreshModuleData();
  }

  async function syncShipment(id: string) {
    await onSync({ shipmentIds: [id] });
    await refreshModuleData();
  }

  function toggleShipment(id: string) {
    setSelectedShipments((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const trackingShipments = data?.shipments || [];
  const allTrackingSelected = trackingShipments.length > 0 && trackingShipments.every((shipment) => selectedShipments.has(shipment.id));

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
      {page === 'tracking' && <div className="heading-actions"><button className="secondary-button" onClick={onOpenManual}><Pencil size={16} />人工补录</button><button className="secondary-button" onClick={onUpload}><Upload size={16} />导入 Excel</button><a className="primary-link-button" href="/api/workbooks/current"><Download size={16} />下载当前 Excel</a></div>}
      {page === 'automation' && <button className="primary-button" onClick={async () => { await onSync(); await refreshModuleData(); }} disabled={syncing}><RefreshCw size={16} className={syncing ? 'spin' : ''} />立即执行</button>}
    </section>

    {moduleLoading && <div className="module-loading"><LoaderCircle className="spin" />正在加载模块数据…</div>}

      {page === 'tracking' && <section className="module-card">
      <div className="module-card-header"><div><strong>全部追踪记录</strong><span>Excel 当前共 {trackingShipments.length} 条 · 可单独或批量更新指定船期</span></div><div className="table-header-actions">{selectedShipments.size > 0 && <><button className="secondary-button compact-button" onClick={() => onSync({ shipmentIds: [...selectedShipments] })} disabled={syncing}><RefreshCw size={14} />更新已选 ({selectedShipments.size})</button><button className="danger-button" onClick={() => onDelete([...selectedShipments])} disabled={syncing}><Trash2 size={13} />删除已选</button></>}<div className="compact-legend"><span className="legend-dot success" />已完成卸船<span className="legend-dot info" />等待卸船<span className="legend-dot muted-dot" />等待到港</div></div></div>
      <div className="module-table-wrap"><table className="module-table"><thead><tr><th className="check-col"><input type="checkbox" checked={allTrackingSelected} onChange={() => setSelectedShipments(allTrackingSelected ? new Set() : new Set(trackingShipments.map((shipment) => shipment.id)))} /></th><th>船司</th><th>提单号</th><th>柜号</th><th>到港时间</th><th>卸船时间</th><th>船只状态</th><th>人工标记</th><th>进度</th><th>最后更新</th><th>真实性核验</th><th>操作</th></tr></thead><tbody>
        {trackingShipments.map((item) => <tr key={item.id} className={`${selectedShipments.has(item.id) ? 'selected-row' : ''} ${item.manualMark === '已清关' ? 'cleared-row' : ''}`}><td className="check-col"><input type="checkbox" checked={selectedShipments.has(item.id)} onChange={() => toggleShipment(item.id)} /></td><td><div className="carrier-cell"><CarrierMark code={item.carrierCode} /><div><strong>{carrierLabel(item.carrierCode, item.carrier)}</strong><span>{item.carrierCode}</span></div></div></td><td className="mono">{item.billNo}</td><td className="mono">{item.containerNo || '—'}</td><td><div className="date-cell eta">{formatDateTime(item.eta, true)}</div></td><td><div className="date-cell discharge">{formatDateTime(item.dischargeTime, true)}</div></td><td><VesselStateBadge shipment={item} /></td><td><ManualMarkSelect value={item.manualMark} onChange={(value) => onMark(item.id, value)} disabled={syncing} /></td><td><ProgressBadge shipment={item} /></td><td>{timeAgo(item.lastUpdated)}</td><td><VerificationActions shipment={item} compact /></td><td><div className="row-actions"><button className="row-action" title="人工修改时间与状态" onClick={() => onOpenEdit(item)}><Pencil size={14} /></button><button className="row-action" title="只更新这一条船期" onClick={() => syncShipment(item.id)} disabled={syncing || item.manualMark === '已清关'}><RefreshCw size={14} /></button><button className="row-action danger-action" title="删除这条记录" onClick={() => onDelete([item.id])} disabled={syncing}><Trash2 size={14} /></button><button className="row-action" title="查看追踪详情" onClick={() => onOpenDetail(item)}><ChevronRight size={17} /></button></div></td></tr>)}
      </tbody></table></div>
    </section>}

    {page === 'sources' && <section className="carrier-grid">
      {carrierRules.map((rule) => {
        const integrationLabel = { ready: '已接入', blocked: '浏览器仍受风控', limited: '浏览器备用已接入', error: '官网接口异常' }[rule.integration];
        return <article className="carrier-rule-card" key={`${rule.code}-${rule.name}`}><div className="carrier-rule-head"><CarrierMark code={rule.code} /><div><strong>{carrierLabel(rule.code, rule.name)}</strong><span>{rule.prefix} · {rule.code}</span></div><span className={`integration-tag ${rule.integration}`}>{integrationLabel}</span></div><dl><div><dt>查询号码</dt><dd>{rule.removePrefix ? `去除 ${rule.code === 'SMLINE' ? 'SMLM' : rule.prefix} 前缀` : '保留完整提单号'}</dd></div><div><dt>查询方式</dt><dd>{rule.queryMode === 'bill-and-container' ? '提单号 + 柜号均需成功' : rule.queryMode === 'bill-or-container' ? '提单号 / 柜号任一成功' : rule.queryMode === 'bill-then-container' ? '提单失败后改查柜号' : '仅提单号'}</dd></div></dl><p className="integration-message">{rule.integrationMessage}</p><div className="carrier-rule-actions"><a href={rule.url} target="_blank" rel="noreferrer">打开船司查询页面<ExternalLink size={13} /></a><button className="text-action-button" onClick={() => syncCarrier(rule.code)} disabled={syncing}><RefreshCw size={13} />只更新此船司</button></div></article>;
      })}
    </section>}

    {page === 'automation' && <>
      <section className="schedule-grid">
        {(automation?.schedule || []).map((schedule, index) => <article className="schedule-card" key={schedule.time}><div className="schedule-index">0{index + 1}</div><div><span>每日定时任务</span><strong>{schedule.time}</strong><small>Asia/Shanghai · {schedule.cron}</small></div><span className={`enabled-pill ${automation?.enabled ? '' : 'disabled'}`}>{automation?.enabled ? '已启用' : '已停用'}</span></article>)}
      </section>
      <section className="module-card automation-controls"><div><div className="control-icon"><FileSpreadsheet size={18} /></div><div><strong>官方接口 + 网页模拟点击</strong><span>接口失败后使用系统 Chrome 串行查询；页面数据无法核验时保存截图并记录原因</span></div></div><label className="setting-toggle"><span>{automation?.enabled ? '定时任务已启用' : '定时任务已停用'}</span><input type="checkbox" checked={Boolean(automation?.enabled)} onChange={(event) => onToggleAutomation(event.target.checked)} /><span className="switch-slider" /></label></section>
      <section className="module-card task-manager"><div className="module-card-header"><div><strong>自定义自动化任务</strong><span>可按船司或单条船期创建任务；批量执行时按列表顺序逐条完成</span></div><div className="task-toolbar"><button className="secondary-button" onClick={() => setTaskModalOpen(true)}><Save size={14} />新建任务</button>{selectedTasks.size > 0 && <><button className="secondary-button" onClick={runSelectedTasks} disabled={taskRunning}><RefreshCw size={14} />按顺序执行 ({selectedTasks.size})</button><button className="danger-button" onClick={deleteSelectedTasks}><Trash2 size={13} />批量删除</button></>}</div></div><div className="task-list">{tasks.length ? tasks.map((task) => <div className={`task-row ${selectedTasks.has(task.id) ? 'selected-row' : ''}`} key={task.id}><input type="checkbox" checked={selectedTasks.has(task.id)} onChange={() => toggleTask(task.id)} /><div className="task-main"><strong>{task.name}</strong><span>{task.scope === 'all' ? '全部未完成记录' : task.scope === 'carrier' ? `船司：${task.carrierCodes.map((code) => carrierLabel(code)).join('、')}` : `单条船期：${task.shipmentIds.length} 条`} · {task.scheduleTime ? `每天 ${task.scheduleTime}` : '仅手动执行'} · 创建于 {fullDate(task.createdAt)}</span></div><span className={`enabled-pill ${task.enabled ? '' : 'disabled'}`}>{task.enabled ? '已启用' : '已停用'}</span><button className="text-action-button" onClick={() => runTask(task)} disabled={!task.enabled || taskRunning}><RefreshCw size={13} />立即执行</button><button className="row-action" title={task.enabled ? '停用任务' : '启用任务'} onClick={async () => { try { const payload = await apiRequest<{ tasks: AutomationTask[] }>(`/api/automation/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !task.enabled }) }); setTasks(payload.tasks || []); } catch (error) { onToast(error instanceof Error ? error.message : '任务设置保存失败'); } }}><Clock3 size={14} /></button><button className="row-action danger-action" title="删除任务" onClick={async () => { if (!window.confirm(`确认删除任务“${task.name}”？`)) return; setDeletingTask(task.id); try { const payload = await apiRequest<{ tasks: AutomationTask[] }>('/api/automation/tasks/delete-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [task.id] }) }); setTasks(payload.tasks || []); setSelectedTasks((previous) => { const next = new Set(previous); next.delete(task.id); return next; }); onToast('任务已删除'); } catch (error) { onToast(error instanceof Error ? error.message : '删除任务失败'); } finally { setDeletingTask(''); } }} disabled={deletingTask === task.id}><Trash2 size={14} /></button></div>) : <div className="empty-module">尚未创建自定义任务。点击“新建任务”选择全部数据、船司或单条船期。</div>}</div></section>
      <RunHistory runs={runs} selected={selectedRuns} onToggle={toggleRun} onDelete={deleteRun} onDeleteSelected={deleteSelectedRuns} />
      {taskModalOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => !taskSaving && setTaskModalOpen(false)}><section className="task-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">CUSTOM AUTOMATION</p><h2>新建自动化任务</h2><p>选择数据范围和每日执行时间；时间留空时仅支持手动执行。</p></div><button className="drawer-close" onClick={() => setTaskModalOpen(false)} disabled={taskSaving}><X size={19} /></button></div><label className="setting-field"><span>任务名称</span><input value={taskName} onChange={(event) => setTaskName(event.target.value)} placeholder="例如：上午重点船司更新" /></label><label className="setting-field"><span>每日执行时间（可选）</span><input type="time" value={taskScheduleTime} onChange={(event) => setTaskScheduleTime(event.target.value)} /></label><label className="setting-field"><span>更新范围</span><select value={taskScope} onChange={(event) => { setTaskScope(event.target.value as AutomationTask['scope']); setTaskCarrierCodes([]); setTaskShipmentIds([]); }}><option value="all">全部未完成记录</option><option value="carrier">指定船司</option><option value="shipment">指定船期</option></select></label>{taskScope === 'carrier' && <div className="task-choice-grid">{Array.from(new Set((data?.shipments || []).map((item) => item.carrierCode))).map((code) => <label key={code}><input type="checkbox" checked={taskCarrierCodes.includes(code)} onChange={(event) => setTaskCarrierCodes((previous) => event.target.checked ? [...previous, code] : previous.filter((item) => item !== code))} />{carrierLabel(code)}</label>)}</div>}{taskScope === 'shipment' && <div className="task-choice-grid shipment-choice-grid">{(data?.shipments || []).map((item) => <label key={item.id}><input type="checkbox" checked={taskShipmentIds.includes(item.id)} onChange={(event) => setTaskShipmentIds((previous) => event.target.checked ? [...previous, item.id] : previous.filter((id) => id !== item.id))} /><span>{carrierLabel(item.carrierCode, item.carrier)} · {item.billNo}</span></label>)}</div>}<div className="modal-actions"><button className="secondary-button" onClick={() => setTaskModalOpen(false)} disabled={taskSaving}>取消</button><button className="primary-button" onClick={createTask} disabled={taskSaving}>{taskSaving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{taskSaving ? '保存中…' : '创建任务'}</button></div></section></div>}
    </>}

    {page === 'exports' && <>
      <section className="export-summary-grid"><article><FileCheck2 size={20} /><div><span>当前工作簿</span><strong>{automation?.workbook?.records || 0} 条记录</strong><small>{automation?.workbook ? fullDate(automation.workbook.modifiedAt) : '尚未导入'}</small></div><a href={automation?.workbook ? '/api/workbooks/current' : '#'} onClick={(event) => { if (!automation?.workbook) { event.preventDefault(); onToast('请先导入 Excel 或新增单号'); } }}>下载<Download size={14} /></a></article><article><Archive size={20} /><div><span>备份文件</span><strong>{backups.length} 个文件</strong><small>更新前自动生成，也可手动创建</small></div><button className="secondary-button backup-create" onClick={async () => { await onCreateBackup(); await refreshModuleData(); }} disabled={!automation?.workbook}>创建备份</button></article><article><FileSpreadsheet size={20} /><div><span>运行记录</span><strong>{runs.length} 次</strong><small>最多保留最近 30 次</small></div></article></section>
      <section className="module-card"><div className="module-card-header"><div><strong>备份文件</strong><span>按时间倒序排列；恢复会先备份当前文件，删除后不可恢复</span></div>{backups.length > 0 && <div className="backup-toolbar"><label><input type="checkbox" checked={selectedBackups.size === backups.length} onChange={(event) => setSelectedBackups(event.target.checked ? new Set(backups.map((item) => item.name)) : new Set())} />全选</label>{selectedBackups.size > 0 && <button className="danger-button" onClick={deleteSelectedBackups} disabled={Boolean(deletingBackup)}><Trash2 size={13} />批量删除 ({selectedBackups.size})</button>}</div>}</div><div className="backup-list">{backups.length ? backups.map((backup) => <div className={selectedBackups.has(backup.name) ? 'selected-row' : ''} key={backup.name}><input type="checkbox" checked={selectedBackups.has(backup.name)} onChange={() => toggleBackup(backup.name)} /><div className="backup-icon"><Archive size={17} /></div><div className="backup-main"><strong>{backup.name}</strong><span>{backup.reason} · {(backup.size / 1024).toFixed(1)} KB · {fullDate(backup.createdAt)}</span></div><div className="backup-actions"><a href={`/api/backups/${encodeURIComponent(backup.name)}`}><Download size={15} />下载</a><button className="restore-button" onClick={async () => { await onRestoreBackup(backup.name); await refreshModuleData(); }} disabled={!automation?.workbook || Boolean(deletingBackup)}>恢复</button><button className="danger-button" onClick={() => deleteBackup(backup.name)} disabled={Boolean(deletingBackup)}><Trash2 size={13} />{deletingBackup === backup.name ? '删除中…' : '删除'}</button></div></div>) : <div className="empty-module">尚无备份文件，执行一次更新或手动创建备份后会显示。</div>}</div></section>
    </>}

    {page === 'settings' && <section className="settings-grid">
      <article className="settings-card"><div className="settings-card-title"><Server size={19} /><div><strong>采集服务</strong><span>本地服务器运行状态</span></div><span className="setting-ok">运行中</span></div><div className="setting-row"><span>运行模式</span><strong>真实官网数据</strong></div><div className="setting-row"><span>支持船司规则</span><strong>{automation?.supportedCarriers || 15} 家</strong></div><div className="setting-row"><span>服务端口</span><strong>{window.location.port || '8787'}</strong></div></article>
      <article className="settings-card"><div className="settings-card-title"><Timer size={19} /><div><strong>计划任务</strong><span>仅在服务持续运行时执行</span></div><span className={automation?.enabled ? 'setting-ok' : 'setting-warn'}>{automation?.enabled ? '已启用' : '已停用'}</span></div><div className="setting-row"><span>定时任务开关</span><label className="setting-toggle"><span>{automation?.enabled ? '启用' : '停用'}</span><input type="checkbox" checked={Boolean(automation?.enabled)} onChange={(event) => onToggleAutomation(event.target.checked)} /><span className="switch-slider" /></label></div><div className="setting-row"><span>执行时区</span><strong>{automation?.timezone || 'Asia/Shanghai'}</strong></div><div className="setting-row"><span>执行时间</span><strong>{automation?.schedule.map((item) => item.time).join(' / ')}</strong></div><div className="setting-row"><span>查询范围</span><strong>未到港或未卸船</strong></div></article>
      <article className="settings-card"><div className="settings-card-title"><Globe2 size={19} /><div><strong>网页模拟点击</strong><span>官方接口失败后的自动备用通道</span></div><span className={settingsView?.browserAutomationEnabled ? 'setting-ok' : 'setting-warn'}>{settingsView?.browserAutomationEnabled ? '已启用' : '已停用'}</span></div><div className="setting-row"><span>浏览器备用查询</span><label className="setting-toggle"><span>{settingsView?.browserAutomationEnabled ? '启用' : '停用'}</span><input type="checkbox" checked={Boolean(settingsView?.browserAutomationEnabled)} disabled={browserSaving} onChange={(event) => saveBrowserAutomation(event.target.checked)} /><span className="switch-slider" /></label></div><div className="setting-row"><span>运行方式</span><strong>系统 Chrome · 无界面</strong></div><div className="setting-row"><span>并发策略</span><strong>单线程串行，降低风控</strong></div><div className="setting-help">页面必须同时显示对应提单号/柜号和明确时间字段才会写入；验证码、空页面或无法核验的数据仍按失败处理，并保存证据截图。</div></article>
      <article className="settings-card wecom-settings"><div className="settings-card-title"><MessageSquare size={19} /><div><strong>企业微信通知</strong><span>任务完成后发送汇总</span></div><span className={settingsView?.notificationConfigured || automation?.notificationConfigured ? 'setting-ok' : 'setting-warn'}>{settingsView?.notificationConfigured || automation?.notificationConfigured ? '已配置' : '待配置'}</span></div><div className="setting-help">可直接在这里保存企业微信机器人 Webhook。密钥只保存在本机服务端，不会回显完整地址。</div><label className="setting-field"><span>机器人 Webhook</span><input type="url" value={webhookInput} onChange={(event) => setWebhookInput(event.target.value)} placeholder={settingsView?.webhookPreview || 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'} /></label><div className="setting-preview">{settingsView?.notificationConfigured ? `当前配置：${settingsView.webhookPreview}` : '当前未配置企业微信通知'}</div><div className="setting-actions"><button className="secondary-button" onClick={testWebhook} disabled={webhookTesting || (!webhookInput.trim() && !settingsView?.notificationConfigured)}><Send size={15} />{webhookTesting ? '发送中…' : '发送测试'}</button><button className="primary-button" onClick={saveWebhook} disabled={webhookSaving}>{webhookSaving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{webhookSaving ? '保存中…' : '保存配置'}</button></div></article>
    </section>}
  </div>;
}

function RunHistory({ runs, selected, onToggle, onDelete, onDeleteSelected }: { runs: RunView[]; selected: Set<string>; onToggle: (id: string) => void; onDelete: (id: string) => void; onDeleteSelected: () => Promise<void> }) {
  return <section className="module-card"><div className="module-card-header"><div><strong>任务运行记录</strong><span>最近 {runs.length} 次 · 失败记录包含船司、提单号、柜号、官网原因和浏览器证据</span></div>{selected.size > 0 && <button className="danger-button" onClick={onDeleteSelected}><Trash2 size={13} />批量删除 ({selected.size})</button>}</div><div className="run-list">{runs.length ? runs.map((run) => <article className="run-entry" key={run.id}><div className="run-summary"><input type="checkbox" checked={selected.has(run.id)} onChange={() => onToggle(run.id)} /><span className={`run-state ${run.failed ? 'failed' : 'success'}`}>{run.failed ? <CircleAlert size={15} /> : <Check size={15} />}</span><div className="run-main"><strong>{run.reason === 'scheduled' ? '定时更新' : '手动更新'}</strong><span>{run.id} · {fullDate(run.finishedAt)}</span></div><div className="run-stats"><span>查询 <strong>{run.total}</strong></span><span>成功 <strong>{run.success}</strong></span><span>未完成 <strong>{run.unfinished}</strong></span><span className={run.failed ? 'danger-text' : ''}>失败 <strong>{run.failed}</strong></span></div><span className={`notify-state ${run.notification}`}>{run.notification === 'sent' ? '通知已发送' : run.notification === 'failed' ? '通知失败' : '未配置通知'}</span><button className="row-action danger-action" title="删除运行记录" onClick={() => onDelete(run.id)}><Trash2 size={14} /></button></div>{run.failedDetails?.length ? <div className="run-failures">{run.failedDetails.map((detail) => <div key={`${run.id}-${detail.billNo}-${detail.containerNo}`}><span className="failure-category">{detail.category}</span><strong>{detail.carrier} · {detail.billNo}</strong><span>柜号：{detail.containerNo || '未提供'}</span><p>{detail.reason}</p><a className="evidence-link" href={detail.sourceUrl} target="_blank" rel="noreferrer" onClick={() => navigator.clipboard?.writeText(detail.billNo).catch(() => undefined)}>打开官网重试<ExternalLink size={12} /></a>{detail.evidencePath ? <a className="evidence-link" href={detail.evidencePath} target="_blank" rel="noreferrer">查看浏览器失败截图<ExternalLink size={12} /></a> : null}</div>)}</div> : null}</article>) : <div className="empty-module">尚无运行记录。</div>}</div></section>;
}

function ManualMarkSelect({ value, onChange, disabled = false }: { value: ManualMark; onChange: (value: ManualMark) => void | Promise<void>; disabled?: boolean }) {
  return <select
    className={`manual-mark-select mark-${value || 'none'}`}
    value={value || ''}
    aria-label="人工标记"
    disabled={disabled}
    onChange={(event) => void onChange(event.target.value as ManualMark)}
  >
    {manualMarkOptions.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}
  </select>;
}

function MetricCard({ title, value, suffix, trend, icon, tone, alert = false, onClick }: { title: string; value: number; suffix: string; trend: string; icon: React.ReactNode; tone: string; alert?: boolean; onClick: () => void }) {
  return <button type="button" className={`metric-card ${alert ? 'alert-card' : ''}`} onClick={onClick}><div className={`metric-icon ${tone}`}>{icon}</div><span className="metric-title">{title}</span><div className="metric-value"><strong>{String(value).padStart(2, '0')}</strong><span>{suffix}</span></div><p><span className={`mini-dot ${tone}`} />{trend}</p><span className="metric-open">查看列表<ChevronRight size={13} /></span></button>;
}

function MetricListModal({ metricKey, shipments, syncing, onClose, onExport, onMark, onSync, onDelete, onEdit, onDetail }: {
  metricKey: MetricKey;
  shipments: Shipment[];
  syncing: boolean;
  onClose: () => void;
  onExport: (shipments: Shipment[]) => Promise<void>;
  onMark: (id: string, manualMark: ManualMark) => Promise<void>;
  onSync: (ids: string[]) => Promise<void>;
  onDelete: (ids: string[]) => Promise<void>;
  onEdit: (shipment: Shipment) => void;
  onDetail: (shipment: Shipment) => void;
}) {
  const [dateField, setDateField] = useState<ShipmentDateField>('eta');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [timeSort, setTimeSort] = useState<ShipmentSort>('default');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const filtered = useMemo(() => filterAndSortShipments(shipments, dateField, dateFrom, dateTo, timeSort), [shipments, dateField, dateFrom, dateTo, timeSort]);
  const allSelected = filtered.length > 0 && filtered.every((shipment) => selected.has(shipment.id));
  const titles: Record<MetricKey, string> = {
    tracking: '追踪中的货物', arriving: '未来 48 小时到港', working: '正在码头作业', completed: '已完成卸船', changed: '计划有变更',
  };

  useEffect(() => {
    const existing = new Set(shipments.map((shipment) => shipment.id));
    setSelected((previous) => new Set([...previous].filter((id) => existing.has(id))));
  }, [shipments]);

  function toggleOne(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return <div className="modal-backdrop metric-list-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="metric-list-modal" role="dialog" aria-modal="true" aria-labelledby="metric-list-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-heading metric-list-heading"><div><p className="eyebrow">SHIPMENT LIST</p><h2 id="metric-list-title">{titles[metricKey]}</h2><p>当前 {filtered.length} 条，可按日期筛选、时间排序并导出当前结果。</p></div><button className="drawer-close" aria-label="关闭" onClick={onClose}><X size={19} /></button></div>
      <div className="metric-list-toolbar">
        <label><span>日期字段</span><select value={dateField} onChange={(event) => setDateField(event.target.value as ShipmentDateField)}><option value="eta">到港时间</option><option value="dischargeTime">卸船时间</option><option value="lastUpdated">最后更新时间</option></select></label>
        <label><span>开始日期</span><input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
        <label><span>结束日期</span><input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
        <label><span>时间排序</span><select value={timeSort} onChange={(event) => setTimeSort(event.target.value as ShipmentSort)}><option value="default">默认顺序</option><option value="asc">从早到晚</option><option value="desc">从晚到早</option></select></label>
        <button className="secondary-button metric-reset" onClick={() => { setDateFrom(''); setDateTo(''); setTimeSort('default'); }}>重置</button>
      </div>
      <div className="metric-list-actions">
        <span>已选择 {selected.size} 条</span>
        <div>{selected.size > 0 && <><button className="secondary-button" onClick={() => onSync([...selected])} disabled={syncing}><RefreshCw size={14} />更新已选</button><button className="danger-button" onClick={() => onDelete([...selected])} disabled={syncing}><Trash2 size={13} />删除已选</button></>}<button className="secondary-button" onClick={() => onExport(filtered)} disabled={!filtered.length}><Download size={14} />导出当前列表</button></div>
      </div>
      <div className="metric-list-table"><table><thead><tr><th className="check-col"><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(filtered.map((shipment) => shipment.id)))} /></th><th>船司</th><th>提单号 / 柜号</th><th>到港时间</th><th>卸船时间</th><th>船只状态</th><th>人工标记</th><th>最后更新</th><th>操作</th></tr></thead><tbody>{filtered.length ? filtered.map((item) => <tr key={item.id} className={`${selected.has(item.id) ? 'selected-row' : ''} ${item.manualMark === '已清关' ? 'cleared-row' : ''}`}><td className="check-col"><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleOne(item.id)} /></td><td><div className="carrier-cell"><CarrierMark code={item.carrierCode} /><div><strong>{carrierLabel(item.carrierCode, item.carrier)}</strong><span>{item.carrierCode}</span></div></div></td><td><div className="stacked"><strong className="mono">{item.billNo}</strong><span className="mono muted">{item.containerNo || '—'}</span></div></td><td><div className="date-cell eta">{formatDateTime(item.eta, true)}</div></td><td><div className="date-cell discharge">{formatDateTime(item.dischargeTime, true)}</div></td><td><VesselStateBadge shipment={item} /></td><td><ManualMarkSelect value={item.manualMark} onChange={(value) => onMark(item.id, value)} disabled={syncing} /></td><td><div className="update-cell"><span>{timeAgo(item.lastUpdated)}</span><small>{formatDateTime(item.lastUpdated)}</small></div></td><td><div className="row-actions"><button className="row-action" title="人工修改时间与状态" onClick={() => { onClose(); onEdit(item); }} disabled={syncing}><Pencil size={14} /></button><button className="row-action" title="只更新这一条" onClick={() => onSync([item.id])} disabled={syncing || item.manualMark === '已清关'}><RefreshCw size={14} /></button><button className="row-action danger-action" title="删除这条记录" onClick={() => onDelete([item.id])} disabled={syncing}><Trash2 size={14} /></button><button className="row-action" title="查看详情" onClick={() => { onClose(); onDetail(item); }}><ChevronRight size={17} /></button></div></td></tr>) : <tr><td colSpan={9}><div className="empty-state"><Search size={23} /><strong>当前条件下没有记录</strong><span>调整日期范围后再试</span></div></td></tr>}</tbody></table></div>
    </section>
  </div>;
}

function SourcePill({ source }: { source: CarrierSource }) {
  return <div className="source-pill"><span className="source-color" style={{ background: source.color }} /><div><strong>{carrierLabel(source.code, source.name)}</strong><span>{source.recordCount} 条 · {source.status === 'online' ? '真实查询成功' : source.status === 'warning' ? '官网返回异常' : '等待本次真实查询'}</span></div><span className={`source-status ${source.status}`} /></div>;
}

function SyncProgress({ progress }: { progress: NonNullable<AutomationStatus['currentRun']> }) {
  const percent = progress.total ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;
  const phaseLabel = {
    preparing: '准备查询数据',
    querying: '正在查询船司官网',
    saving: '正在保存 Excel',
    notifying: '正在发送企业微信通知',
  }[progress.phase];
  return <section className="sync-progress" aria-live="polite">
    <div className="sync-progress-head"><div><strong>{phaseLabel}</strong><span>任务 {progress.id} · {progress.completed} / {progress.total} 条已处理</span></div><strong>{percent}%</strong></div>
    <div className="sync-progress-track"><span style={{ width: `${percent}%` }} /></div>
    <div className="sync-progress-foot"><span>成功 {progress.success}</span><span>失败 {progress.failed}</span><span>跳过 {progress.skipped}</span><span className="sync-current">{progress.currentBills.length ? `当前：${progress.currentBills.slice(0, 3).map((item) => `${item.carrier} ${item.billNo}`).join('、')}${progress.currentBills.length > 3 ? '…' : ''}` : '正在切换下一条'}</span></div>
  </section>;
}

function ManualFormModal({ form, saving, onChange, onClose, onSave }: { form: ManualForm; saving: boolean; onChange: (form: ManualForm) => void; onClose: () => void; onSave: () => void }) {
  function update(patch: Partial<ManualForm>) {
    onChange({ ...form, ...patch });
  }

  function updateState(vesselState: ManualForm['vesselState']) {
    update({
      vesselState,
      arrivalTime: vesselState === '未到港未卸船' ? '' : form.arrivalTime,
      dischargeTime: vesselState === '已到港已卸船' ? form.dischargeTime : '',
    });
  }

  function updateArrivalTime(arrivalTime: string) {
    update({
      arrivalTime,
      vesselState: arrivalTime && form.vesselState === '未到港未卸船' ? '已到港未卸船' : form.vesselState,
    });
  }

  function updateDischargeTime(dischargeTime: string) {
    update({
      dischargeTime,
      vesselState: dischargeTime
        ? '已到港已卸船'
        : form.vesselState === '已到港已卸船'
          ? form.arrivalTime ? '已到港未卸船' : '未到港未卸船'
          : form.vesselState,
    });
  }

  return <div className="modal-backdrop manual-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="manual-modal" role="dialog" aria-modal="true" aria-labelledby="manual-form-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-heading"><div><p className="eyebrow">MANUAL TRACKING ENTRY</p><h2 id="manual-form-title">{form.mode === 'new' ? '人工补录追踪数据' : '人工修改船期时间与状态'}</h2><p>保存前会自动备份 Excel，并在备注中标记为人工数据。</p></div><button className="drawer-close" onClick={onClose} disabled={saving}><X size={19} /></button></div>
      <div className="manual-grid">
        <label className="setting-field"><span>提单号</span><input value={form.billNo} onChange={(event) => update({ billNo: event.target.value.toUpperCase() })} disabled={form.mode === 'edit'} placeholder="必填" /></label>
        <label className="setting-field"><span>柜号</span><input value={form.containerNo} onChange={(event) => update({ containerNo: event.target.value.toUpperCase() })} disabled={form.mode === 'edit'} placeholder="可选" /></label>
        <label className="setting-field manual-full"><span>船司</span><input value={form.carrierHint} onChange={(event) => update({ carrierHint: event.target.value })} disabled={form.mode === 'edit'} placeholder="可不填，系统按提单号识别" /></label>
        <label className="setting-field"><span>到港时间</span><input type="datetime-local" value={form.arrivalTime} onChange={(event) => updateArrivalTime(event.target.value)} /></label>
        <label className="setting-field"><span>卸船时间</span><input type="datetime-local" value={form.dischargeTime} onChange={(event) => updateDischargeTime(event.target.value)} /></label>
        <label className="setting-field manual-full"><span>船只状态</span><select value={form.vesselState} onChange={(event) => updateState(event.target.value as ManualForm['vesselState'])}><option value="未到港未卸船">未到港未卸船</option><option value="已到港未卸船">已到港未卸船</option><option value="已到港已卸船">已到港已卸船</option></select></label>
        <label className="setting-field manual-full"><span>人工备注</span><textarea value={form.note} onChange={(event) => update({ note: event.target.value })} placeholder="例如：人工从码头回执核实，或官网人工查询结果" /></label>
      </div>
      <div className="manual-hint"><CircleAlert size={15} /><span>到港时间和卸船时间可直接覆盖解析结果；填写到港时间会自动切换为“已到港未卸船”，填写卸船时间会自动切换为“已到港已卸船”。选择船只状态仍可主动清空不适用的时间。</span></div>
      <div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" onClick={onSave} disabled={saving || !form.billNo.trim()}>{saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{saving ? '保存中…' : '保存人工数据'}</button></div>
    </section>
  </div>;
}

function DetailItem({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="detail-item"><span>{label}</span><strong>{value}</strong></div>;
}

function TimelineItem({ label, value, active = false, last = false }: { label: string; value: React.ReactNode; active?: boolean; last?: boolean }) {
  return <div className={`timeline-item ${active ? 'active' : ''} ${last ? 'last' : ''}`}><span className="timeline-dot" /><div><span>{label}</span><strong>{value}</strong></div></div>;
}
