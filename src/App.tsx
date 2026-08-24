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
  Eraser,
  ExternalLink,
  FileSpreadsheet,
  FileCheck2,
  Filter,
  Globe2,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  MapPin,
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
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type { AutomationStatus, AutomationTask, CarrierSource, DashboardData, ManualMark, Shipment, ShipmentStatus } from './types';

type PageId = 'overview' | 'tracking' | 'history' | 'sources' | 'automation' | 'exports' | 'settings';

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

interface AuthManagedUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ManualCollectionSessionView {
  id: string;
  token: string;
  carrierCode: 'CMA' | 'HAPAG';
  carrierName: string;
  shipmentId: string;
  billNo: string;
  queryBillNo: string;
  containerNo: string;
  queryType: 'bill' | 'container';
  sourceUrl: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  lastError?: string;
  completedAt?: string;
  result?: { arrivalKind: 'ATA' | 'ETA' | null; arrived: boolean; discharged: boolean; evidencePath?: string };
}

const emptyDashboard: DashboardData = { shipments: [], sources: [], generatedAt: new Date(0).toISOString() };

let csrfToken = '';
let authExpiryDispatched = false;

type RunSelection = { carrierCodes?: string[]; shipmentIds?: string[]; skipCompleted?: boolean };
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
  { id: 'history', label: '清关历史', icon: Archive },
  { id: 'sources', label: '数据源管理', icon: Database },
  { id: 'automation', label: '自动化任务', icon: Timer },
  { id: 'exports', label: '导出与备份', icon: FileSpreadsheet },
];

const pageTitles: Record<PageId, string> = {
  overview: '运营总览', tracking: '船期追踪', history: '清关历史', sources: '数据源管理', automation: '自动化任务', exports: '导出与备份', settings: '系统设置',
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
  if (/确认已卸船，但未提供精确卸船时刻/.test(note)) return '已确认卸船完成，官网未提供精确卸船时间';
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
    if (response.status === 401) {
      if (!authExpiryDispatched) {
        authExpiryDispatched = true;
        window.dispatchEvent(new Event('port-ops-auth-expired'));
      }
      throw new Error('登录状态已失效，请重新登录');
    }
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
    const code = typeof payload === 'object' && payload && 'code' in payload ? String(payload.code) : '';
    if (response.status === 401 && code === 'AUTH_REQUIRED') {
      if (!authExpiryDispatched) {
        authExpiryDispatched = true;
        window.dispatchEvent(new Event('port-ops-auth-expired'));
      }
      throw new Error('登录状态已失效，请重新登录');
    }
    const message = typeof payload === 'object' && payload && 'message' in payload ? String(payload.message) : `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

function idempotencyKey(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
  if (!shipment.sourceUrl && !shipment.evidencePath && !shipment.failureEvidencePath) return <span className="empty-value">暂无来源</span>;
  const verificationNo = shipment.verificationNo || shipment.billNo;
  return <div className={compact ? 'verification-actions compact' : 'verification-actions'}>
    {shipment.evidencePath ? <a
      className={compact ? 'verification-link compact evidence' : 'verification-link evidence'}
      href={shipment.evidencePath}
      target="_blank"
      rel="noreferrer"
      title="查看本次自动查询保存的网页截图或官方接口采集凭证"
    >
      {compact ? '采集证据' : '查看本次采集证据'}<ExternalLink size={compact ? 12 : 14} />
    </a> : null}
    {shipment.failureEvidencePath ? <a
      className={compact ? 'verification-link compact evidence' : 'verification-link evidence'}
      href={shipment.failureEvidencePath}
      target="_blank"
      rel="noreferrer"
      title="查看本次失败查询保留的浏览器截图"
    >
      {compact ? '失败截图' : '查看本次失败截图'}<ExternalLink size={compact ? 12 : 14} />
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

function VerificationModal({ verification, onSkip, onContinue }: {
  verification: NonNullable<AutomationStatus['currentRun']>['verification'];
  onSkip: () => Promise<void>;
  onContinue: () => void;
}) {
  if (!verification) return null;
  return <div className="verification-notice" role="status" aria-live="polite">
    <section className="verification-modal" aria-labelledby="verification-title">
      <div className="verification-modal-icon"><ShieldCheckIcon /></div>
      <p className="eyebrow">HUMAN VERIFICATION REQUIRED</p>
      <h2 id="verification-title">需要人工通过船司验证</h2>
      <p className="verification-modal-copy">{verification.carrier} 的官网暂时要求验证。请在自动打开的 Chrome 窗口中完成验证，系统会自动检测通过状态并继续查询。</p>
      <div className="verification-record"><strong>{verification.billNo}</strong><span>{verification.containerNo || '未提供柜号'} · {verification.carrierCode}</span></div>
      <div className="verification-modal-actions"><button className="secondary-button" onClick={onContinue}>我已完成验证，继续等待</button><button className="danger-button" onClick={() => void onSkip()}>跳过当前记录</button></div>
      <small>跳过后本条会记录为失败，不会写入未经核验的时间。</small>
    </section>
  </div>;
}

function ShieldCheckIcon() {
  return <span className="verification-shield">✓</span>;
}

function ManualCollectionModal({ session, onClose, onCopy, onCopyQuery }: { session: ManualCollectionSessionView; onClose: () => void; onCopy: () => void; onCopyQuery: () => void }) {
  const queryValue = session.queryType === 'container' ? session.containerNo : session.queryBillNo;
  const expiresAt = new Date(session.expiresAt);
  const validUntil = Number.isNaN(expiresAt.getTime()) ? session.expiresAt : expiresAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="manual-collection-modal" role="dialog" aria-modal="true" aria-labelledby="manual-collection-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-heading"><div><p className="eyebrow">NORMAL BROWSER COLLECTION</p><h2 id="manual-collection-title">{session.carrierName}普通浏览器采集</h2><p>不会启动自动化 Chrome；请在日常浏览器中完成验证和查询。</p></div><button className="drawer-close" onClick={onClose}><X size={19} /></button></div>
      <div className="manual-collection-target"><div><strong>{queryValue}</strong><span>{session.queryType === 'bill' ? '提单号查询' : '完整柜号查询'} · {session.containerNo || '未提供柜号'}</span></div><button className="secondary-button compact-button" onClick={onCopyQuery}>复制{session.queryType === 'bill' ? '提单号' : '柜号'}</button></div>
      <ol className="manual-collection-steps"><li>复制下面的一次性令牌。</li><li>点击“打开官网”，用普通 Chrome/Edge 完成安全验证和查询；赫伯罗特请进入 Details 页面。</li><li>打开“港航工作台船期采集器”扩展，粘贴令牌并点击“采集当前页面”。</li></ol>
      <div className="manual-token-row"><code>{session.token}</code><button className="secondary-button compact-button" onClick={onCopy}>复制令牌</button></div>
      <div className={`manual-collection-status ${session.status}`}><strong>{session.status === 'pending' ? '等待浏览器采集' : session.status === 'success' ? '采集成功，已写入 Excel' : '本次采集失败'}</strong><span>{session.status === 'pending' ? `令牌有效至 ${validUntil}；当前尝试 ${session.attempts} 次` : session.lastError || '工作台已完成解析。'}</span></div>
      <div className="manual-collection-links"><a className="secondary-button" href={session.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开官网查询页</a><span>扩展目录：<code>browser-extension</code></span></div>
      <div className="modal-actions"><button className="primary-button" onClick={onClose}>{session.status === 'pending' ? '后台等待，关闭窗口' : '完成'}</button></div>
    </section>
  </div>;
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
  const [sourceDetailsOpen, setSourceDetailsOpen] = useState(false);
  const [skipCompletedRecords, setSkipCompletedRecords] = useState(true);
  const [verificationDismissed, setVerificationDismissed] = useState('');
  const [manualCollectionSession, setManualCollectionSession] = useState<ManualCollectionSessionView | null>(null);
  const [manualCollectionOpening, setManualCollectionOpening] = useState(false);
  const moreFilterRef = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const runRequestPending = useRef(false);
  const coreRefreshSeq = useRef(0);

  const verification = automation?.currentRun?.verification;
  const verificationKey = verification ? `${verification.carrierCode}:${verification.billNo}:${verification.containerNo}` : '';

  useEffect(() => {
    if (!verificationKey) {
      setVerificationDismissed('');
    } else if (verificationDismissed && verificationDismissed !== verificationKey) {
      setVerificationDismissed('');
    }
  }, [verificationKey, verificationDismissed]);

  async function refreshSession() {
    const response = await fetch('/api/auth/session', { credentials: 'include' });
    const payload = await response.json() as AuthSession;
    csrfToken = payload.csrfToken || '';
    if (payload.authenticated) authExpiryDispatched = false;
    setAuth(payload);
    return payload;
  }

  async function login(username: string, password: string) {
    const payload = await apiRequest<AuthSession>('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    csrfToken = payload.csrfToken || '';
    authExpiryDispatched = false;
    setAuth(payload);
    navigate('overview');
    await refreshCoreData();
    setLoading(false);
  }

  async function logout() {
    await apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    csrfToken = '';
    authExpiryDispatched = false;
    setAuth((previous) => previous ? { ...previous, authenticated: false, user: null, csrfToken: '' } : previous);
  }

  async function skipVerification() {
    try {
      const payload = await apiRequest<{ automation: AutomationStatus }>('/api/automation/verification/skip', { method: 'POST' });
      setAutomation(payload.automation);
      setVerificationDismissed('');
      setToast('已跳过当前人工验证记录，任务将继续处理后续单号');
    } catch (error) {
      setToast(error instanceof Error ? error.message : '跳过验证失败');
    }
  }

  async function startManualCollection(shipment: Shipment, queryType: 'bill' | 'container' = 'bill') {
    if (shipment.carrierCode !== 'CMA' && shipment.carrierCode !== 'HAPAG') {
      setToast('普通浏览器采集目前仅支持达飞和赫伯罗特');
      return;
    }
    const effectiveQueryType = shipment.carrierCode === 'HAPAG' ? 'container' : queryType;
    if (effectiveQueryType === 'container' && !shipment.containerNo) {
      setToast('该记录没有柜号，无法发起柜号采集');
      return;
    }
    setManualCollectionOpening(true);
    try {
      const payload = await apiRequest<{ session: ManualCollectionSessionView }>('/api/manual-collection/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shipmentId: shipment.id, queryType: effectiveQueryType }),
      });
      setManualCollectionSession(payload.session);
    } catch (error) {
      setToast(error instanceof Error ? error.message : '无法创建普通浏览器采集会话');
    } finally {
      setManualCollectionOpening(false);
    }
  }

  useEffect(() => {
    if (!manualCollectionSession || manualCollectionSession.status !== 'pending') return;
    let disposed = false;
    const poll = async () => {
      try {
        const payload = await apiRequest<{ session: ManualCollectionSessionView }>(`/api/manual-collection/sessions/${encodeURIComponent(manualCollectionSession.id)}`);
        if (disposed) return;
        setManualCollectionSession(payload.session);
        if (payload.session.status === 'success') {
          await refreshCoreData().catch(() => undefined);
          setToast(`${payload.session.carrierName}普通浏览器采集成功，已写入 Excel`);
        }
      } catch {
        // 会话短暂不可读时保留弹窗，下一轮继续检查。
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [manualCollectionSession?.id, manualCollectionSession?.status]);

  function navigate(page: PageId) {
    setActivePage(page);
    window.location.hash = page;
    setMobileNav(false);
    setProfileMenuOpen(false);
  }

  useEffect(() => {
    const onAuthExpired = () => {
      csrfToken = '';
      setAuth((previous) => previous ? { ...previous, authenticated: false, user: null, csrfToken: '' } : previous);
      setData(null);
      setAutomation(null);
      setLoading(false);
      setToast('登录状态已失效，请重新登录');
    };
    window.addEventListener('port-ops-auth-expired', onAuthExpired);
    return () => window.removeEventListener('port-ops-auth-expired', onAuthExpired);
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const page = window.location.hash.replace('#', '') as PageId;
      if (pageTitles[page]) setActivePage(page);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (auth?.authenticated && auth.user?.role !== 'admin' && activePage === 'settings') {
      setActivePage('overview');
      window.location.hash = 'overview';
    }
  }, [auth?.authenticated, auth?.user?.role, activePage]);

  async function load(endpoint = '/api/dashboard') {
    const payload = await apiRequest<DashboardData>(endpoint, { method: endpoint.includes('sync') ? 'POST' : 'GET' });
    setData(payload);
  }

  async function loadAutomation() {
    setAutomation(await apiRequest<AutomationStatus>('/api/automation'));
  }

  async function refreshCoreData() {
    const requestId = ++coreRefreshSeq.current;
    const [dashboardResult, automationResult] = await Promise.allSettled([
      apiRequest<DashboardData>('/api/dashboard'),
      apiRequest<AutomationStatus>('/api/automation'),
    ]);
    if (requestId !== coreRefreshSeq.current) return;
    if (dashboardResult.status === 'fulfilled') setData(dashboardResult.value);
    if (automationResult.status === 'fulfilled') setAutomation(automationResult.value);
    if (dashboardResult.status === 'rejected' && automationResult.status === 'rejected') {
      throw dashboardResult.reason instanceof Error ? dashboardResult.reason : new Error('工作台数据加载失败');
    }
  }

  useEffect(() => {
    refreshSession().then((session) => {
      if (!session.enabled || !session.authenticated) return undefined;
      navigate('overview');
      return refreshCoreData();
    }).catch((error) => setToast(error.message)).finally(() => { setAuthLoading(false); setLoading(false); });
  }, []);

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
            await refreshCoreData().catch(() => undefined);
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

  useEffect(() => {
    setDetail((current) => current ? data?.shipments.find((shipment) => shipment.id === current.id) || null : current);
  }, [data]);

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
    if (selection?.shipmentIds?.length === 1) {
      const target = data?.shipments.find((shipment) => shipment.id === selection.shipmentIds?.[0]);
      if (target && (target.carrierCode === 'CMA' || target.carrierCode === 'HAPAG')) {
        setDetail(target);
        await startManualCollection(target, target.carrierCode === 'HAPAG' ? 'container' : 'bill');
        return;
      }
    }
    if (runRequestPending.current) {
      setToast('已有同步任务正在执行或排队，请等待当前任务完成');
      return;
    }
    setSyncing(true);
    setPollingRun(true);
    runRequestPending.current = true;
    try {
      if (!automation?.workbook) throw new Error('请先导入 Excel 或新增单号');
      const payload = await apiRequest<{ run: { total: number; success: number; failed: number; skipped: number }; dashboard: DashboardData; automation: AutomationStatus }>('/api/automation/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey('sync') },
        body: JSON.stringify(selection || { skipCompleted: skipCompletedRecords }),
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
      const target = data?.shipments.find((shipment) => shipment.id === id);
      if (!target) throw new Error('船期记录已变化，请刷新页面后重试');
      const payload = await apiRequest<{ dashboard: DashboardData; automation: AutomationStatus }>(`/api/shipments/${encodeURIComponent(id)}/mark`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manualMark, billNo: target.billNo, containerNo: target.containerNo }),
      });
      setData(payload.dashboard);
      setAutomation(payload.automation);
      if (manualMark === '已清关') setSelected((previous) => { const next = new Set(previous); next.delete(id); return next; });
      setDetail((current) => current?.id === id ? payload.dashboard.shipments.find((item) => item.id === id) || null : current);
      setToast(manualMark === '已清关' ? '已移出在途追踪，可在“清关历史”中查看或恢复' : manualMark ? `已标记为${manualMark}` : '已清除人工标记');
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
          headers: { 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey('intake') },
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

  if (authLoading) return <main className="login-screen"><div className="login-card login-loading"><LoaderCircle size={24} className="spin" /><span>正在检查登录状态…</span></div></main>;
  if (auth?.enabled && !auth.authenticated) return <LoginScreen onLogin={login} />;

  const isAdmin = !auth?.enabled || auth.user?.role === 'admin';
  const visibleNavItems = isAdmin ? navItems : navItems.filter((item) => item.id !== 'settings');

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
        <div className="brand"><div className="brand-icon"><Anchor size={22} /></div><div><strong>港航工作台</strong><span>PORT OPS</span></div></div>
        <nav>
          <span className="nav-caption">工作台</span>
          {visibleNavItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={activePage === id ? 'active' : ''} onClick={() => navigate(id)}><Icon size={18} /><span>{label}</span>{activePage === id && <span className="nav-dot" />}</button>
          ))}
          {isAdmin && <><span className="nav-caption lower">管理</span><button className={activePage === 'settings' ? 'active' : ''} onClick={() => navigate('settings')}><Settings size={18} /><span>系统设置</span>{activePage === 'settings' && <span className="nav-dot" />}</button></>}
        </nav>
        <div className="sidebar-foot">
          <div className="system-health"><span className="health-dot" /><div><strong>{isAdmin ? '采集服务正常' : '账号已登录'}</strong><span>{isAdmin ? (data ? `${data.sources.length} 个数据源在线` : '正在连接服务') : '当前账号尚未分配工作区'}</span></div></div>
          <div className="user-card-wrap">
          <button className="user-card" onClick={() => isAdmin ? navigate('settings') : setProfileMenuOpen((value) => !value)}><div className="avatar">A4</div><div><strong>{auth?.user?.username || 'A4专用版'}</strong><span>{auth?.user?.role === 'user' ? '普通用户' : '工作台管理员'}{isAdmin ? ' · 打开系统设置' : ''}</span></div></button>
            <button className="user-menu-button" aria-label="打开工作台菜单" title="工作台菜单" onClick={() => setProfileMenuOpen((value) => !value)}><MoreHorizontal size={17} /></button>
            {profileMenuOpen && <div className="user-menu">{isAdmin && <button onClick={() => navigate('settings')}><Settings size={14} />系统设置</button>}<button onClick={() => { setProfileMenuOpen(false); window.location.reload(); }}><RefreshCw size={14} />重新加载</button>{auth?.enabled ? <button onClick={() => { setProfileMenuOpen(false); void logout(); }}><X size={14} />退出登录</button> : null}</div>}
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
          {(syncing || automation?.running) && automation?.currentRun && <SyncProgress progress={automation.currentRun} queuedRuns={automation.queuedRuns || 0} />}
          {!isAdmin && !(data?.shipments.length) && activePage === 'overview' && <section className="module-card user-workspace-empty"><div className="empty-state"><Users size={25} /><strong>当前账号暂无工作区数据</strong><span>这是独立工作区，可以直接导入 Excel 或新增单号；管理员工作区数据不会显示在这里。</span></div></section>}
          <div className={activePage === 'overview' ? '' : 'hidden-page'}>
          <section className="page-heading">
            <div><p className="eyebrow">OPERATIONS OVERVIEW</p><h1>运营总览</h1><p>集中追踪船期、靠泊与卸船动态，及时掌握异常变化。</p></div>
            <div className="heading-actions"><button className="secondary-button add-record-button" onClick={() => setIntakeOpen(true)}><Ship size={17} />新增单号</button><button className="secondary-button" onClick={openManualNew}><Pencil size={16} />人工补录</button>{selected.size > 0 && <><button className="secondary-button" onClick={handleSelectedSync} disabled={syncing}><RefreshCw size={17} className={syncing ? 'spin' : ''} />更新已选 ({selected.size})</button><button className="danger-button" onClick={() => handleDeleteShipments([...selected])} disabled={syncing}><Trash2 size={15} />删除已选</button></>}<button className="secondary-button" onClick={handleExport}><Download size={17} />导出 Excel</button><label className="sync-option" title="关闭后会连同已完成卸船的记录一起重新查询"><input type="checkbox" checked={skipCompletedRecords} onChange={(event) => setSkipCompletedRecords(event.target.checked)} />跳过已完成卸船</label><button className="primary-button" onClick={() => handleSync({ skipCompleted: skipCompletedRecords })} disabled={syncing}><RefreshCw size={17} className={syncing ? 'spin' : ''} />{syncing ? '同步中…' : '同步最新数据'}</button></div>
          </section>

          <section className="automation-panel">
            <div className="automation-main">
              <div className="automation-symbol"><Timer size={20} /></div>
            <div><div className="automation-heading"><strong>自动化查询</strong><span className="mode-tag live">真实官网数据</span></div><p>支持手动同步，也可在自动化任务中创建自定义执行计划</p></div>
            </div>
            <div className="automation-facts">
              <div><FileCheck2 size={16} /><span>Excel 文件</span><strong>{automation?.workbook ? `${automation.workbook.records} 条记录` : '尚未导入'}</strong></div>
              <div><Timer size={16} /><span>执行计划</span><strong>按自定义任务配置</strong></div>
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
            <MetricCard title="数据有异常" value={metrics.changed} suffix="票" trend="建议优先处理" icon={<CircleAlert size={20} />} tone="orange" alert onClick={() => setMetricView('changed')} />
          </section>

          <section className={`source-strip ${sourceDetailsOpen ? 'expanded' : 'collapsed'}`}>
            <div className="source-summary">
              <div className="source-title"><div className="source-icon"><Database size={19} /></div><div><strong>数据源状态</strong><span>当前 Excel 累计 {successfulSources} 家成功{automation?.lastRun ? ` · 最近一次：查询 ${automation.lastRun.total} 条，成功 ${automation.lastRun.success}、失败 ${automation.lastRun.failed}、跳过 ${automation.lastRun.skipped}` : ''}</span></div></div>
              <div className="source-summary-actions">
                <button className="source-expand-button" type="button" aria-expanded={sourceDetailsOpen} aria-controls="source-status-details" onClick={() => setSourceDetailsOpen((value) => !value)}>{sourceDetailsOpen ? '收起详情' : '展开详情'}<ChevronDown size={15} /></button>
                <button className="manage-link" onClick={() => navigate('sources')}>管理数据源<ChevronRight size={15} /></button>
              </div>
            </div>
            {sourceDetailsOpen && <div className="source-details" id="source-status-details">
              <div className="source-list">
                {(data?.sources || []).map((source) => <SourcePill key={source.id} source={source} />)}
              </div>
            </div>}
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
              <div className="more-filter-wrap" ref={moreFilterRef}><button className={`filter-button ${onlyIncomplete || onlyException || manualMarkFilter !== '全部标记' || dateFrom || dateTo || timeSort !== 'default' ? 'filter-active' : ''}`} onClick={(event) => { event.stopPropagation(); setMoreFilterOpen((value) => !value); }}><Filter size={16} />更多筛选</button>{moreFilterOpen && <div className="more-filter-menu advanced-filter-menu" onClick={(event) => event.stopPropagation()}><strong>高级筛选与排序</strong><label><input type="checkbox" checked={onlyIncomplete} onChange={(event) => setOnlyIncomplete(event.target.checked)} />只看未完成记录</label><label><input type="checkbox" checked={onlyException} onChange={(event) => setOnlyException(event.target.checked)} />只看失败或异常</label><span className="filter-field-label">人工标记</span><select value={manualMarkFilter} onChange={(event) => setManualMarkFilter(event.target.value as typeof manualMarkFilter)}><option value="全部标记">全部标记</option>{manualMarkOptions.filter((option) => option.value !== '已清关').map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}</select><span className="filter-field-label">日期字段</span><select value={dateField} onChange={(event) => setDateField(event.target.value as ShipmentDateField)}><option value="eta">到港时间</option><option value="dischargeTime">卸船时间</option><option value="lastUpdated">最后更新时间</option></select><div className="date-filter-grid"><label><span>开始日期</span><input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label><span>结束日期</span><input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div><span className="filter-field-label">时间排序</span><select value={timeSort} onChange={(event) => setTimeSort(event.target.value as ShipmentSort)}><option value="default">默认顺序</option><option value="asc">时间从早到晚</option><option value="desc">时间从晚到早</option></select><button onClick={() => { setOnlyIncomplete(false); setOnlyException(false); setManualMarkFilter('全部标记'); setDateFrom(''); setDateTo(''); setTimeSort('default'); setMoreFilterOpen(false); }}>重置高级筛选</button></div>}</div>
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
          {activePage === 'history' && <ClearanceHistoryPage onDashboardUpdated={setData} onAutomationUpdated={setAutomation} onToast={setToast} />}
          {activePage !== 'overview' && activePage !== 'history' && (isAdmin || activePage !== 'settings') && <ModulePage page={activePage} data={data} automation={automation} authEnabled={Boolean(auth?.enabled)} currentUser={auth?.user || null} syncing={syncing} onSync={handleSync} onMark={handleManualMark} onDelete={handleDeleteShipments} onToggleAutomation={handleToggleAutomation} onCreateBackup={handleCreateBackup} onRestoreBackup={handleRestoreBackup} onAutomationUpdated={setAutomation} onUpload={() => uploadInput.current?.click()} onToast={setToast} onOpenDetail={setDetail} onOpenEdit={openManualEdit} onOpenManual={openManualNew} />}
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
      {detail && <div className="drawer-backdrop" onClick={() => setDetail(null)}><aside className="detail-drawer" onClick={(event) => event.stopPropagation()}><button className="drawer-close" onClick={() => setDetail(null)}><X size={19} /></button><p className="eyebrow">SHIPMENT DETAIL</p><h2>单号追踪详情</h2><div className="drawer-carrier"><CarrierMark code={detail.carrierCode} /><div><strong>{detail.carrier}</strong><span>{detail.billNo}</span></div></div><div className="detail-grid"><DetailItem label="提单号" value={detail.billNo} /><DetailItem label="官网查询号" value={detail.verificationNo || detail.billNo} /><DetailItem label="柜号" value={detail.containerNo || '—'} /><DetailItem label="查询进度" value={<ProgressBadge shipment={detail} />} /><DetailItem label="船只状态" value={<VesselStateBadge shipment={detail} />} /><DetailItem label="人工标记" value={<ManualMarkSelect value={detail.manualMark} onChange={(value) => handleManualMark(detail.id, value)} disabled={syncing} />} /></div><div className="timeline"><TimelineItem label="到港时间 ATA / ETA" value={formatDateTime(detail.eta)} active={Boolean(detail.eta)} /><TimelineItem label="卸船时间" value={detail.dischargeTime ? formatDateTime(detail.dischargeTime) : detail.vesselState === '已到港已卸船' ? '已确认完成，官网未提供精确时间' : formatDateTime(null)} active={Boolean(detail.dischargeTime || detail.vesselState === '已到港已卸船')} last /></div>{(detail.trackingDetail || detail.route) && <RouteTimeline route={detail.route} detail={detail.trackingDetail} />}{detail.note && <div className="detail-alert"><CircleAlert size={17} /><div><strong>查询备注</strong><span>{detail.note}</span></div></div>}<div className="verification-card"><div><Globe2 size={17} /><div><strong>官网真实性核验</strong><span>官网复核会复制船司实际接受的查询号；森罗会自动去除 SMLM 前缀。部分官网会要求重新查询或接受 Cookie。</span></div></div><VerificationActions shipment={detail} /></div>{(detail.carrierCode === 'CMA' || detail.carrierCode === 'HAPAG') && <div className="manual-collection-card"><div><Globe2 size={17} /><div><strong>普通浏览器采集</strong><span>{detail.carrierCode === 'HAPAG' ? '赫伯罗特固定使用完整柜号查询；完成查询后由扩展采集当前页面。' : '用日常 Chrome/Edge 完成验证和查询，再由扩展采集当前结果页面。'}</span></div></div><div className="manual-collection-actions">{detail.carrierCode === 'CMA' && <button className="secondary-button" onClick={() => void startManualCollection(detail, 'bill')} disabled={manualCollectionOpening}><ExternalLink size={14} />提单号采集</button>}{detail.containerNo && <button className="secondary-button" onClick={() => void startManualCollection(detail, 'container')} disabled={manualCollectionOpening}><ExternalLink size={14} />{detail.carrierCode === 'HAPAG' ? '完整柜号采集' : '柜号采集'}</button>}</div></div>}<div className="drawer-actions"><button className="secondary-button" onClick={() => openManualEdit(detail)}><Pencil size={15} />人工修改时间与状态</button></div><div className="drawer-meta">数据更新于 {formatDateTime(detail.lastUpdated)}</div></aside></div>}
      {manualForm && <ManualFormModal form={manualForm} saving={manualSaving} onChange={setManualForm} onClose={() => !manualSaving && setManualForm(null)} onSave={saveManualForm} />}
      {manualCollectionSession && <ManualCollectionModal session={manualCollectionSession} onClose={() => setManualCollectionSession(null)} onCopy={() => { void navigator.clipboard?.writeText(manualCollectionSession.token).then(() => setToast('采集令牌已复制')).catch(() => setToast('复制失败，请手动选择令牌')); }} onCopyQuery={() => { const value = manualCollectionSession.queryType === 'container' ? manualCollectionSession.containerNo : manualCollectionSession.queryBillNo; void navigator.clipboard?.writeText(value).then(() => setToast(`${manualCollectionSession.queryType === 'bill' ? '提单号' : '柜号'}已复制`)).catch(() => setToast('复制失败，请手动选择号码')); }} />}
      {verification && verificationKey !== verificationDismissed && <VerificationModal verification={verification} onSkip={skipVerification} onContinue={() => setVerificationDismissed(verificationKey)} />}
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

interface ClearanceHistoryEntryView {
  id: string;
  archivedAt: string;
  originalRowNumber: number;
  carrier: string;
  carrierCode: string;
  carrierHint: string;
  billNo: string;
  containerNo: string;
  arrivalTime: string | null;
  dischargeTime: string | null;
  vesselState: NonNullable<Shipment['vesselState']> | '';
  manualMark: '已清关';
  lastUpdated: string | null;
  note: string;
  progress: Shipment['progress'] | '';
}

interface ClearanceHistoryView {
  retentionDays: 3 | 7;
  lastCleanupAt: string | null;
  entries: ClearanceHistoryEntryView[];
}

function fullDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

function historyExpiryText(archivedAt: string, retentionDays: 3 | 7) {
  const expiresAt = new Date(archivedAt).getTime() + retentionDays * 24 * 60 * 60 * 1000;
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return '等待自动清理';
  const hours = Math.ceil(remaining / (60 * 60 * 1000));
  return hours <= 24 ? `${hours} 小时后清理` : `${Math.ceil(hours / 24)} 天后清理`;
}

function ClearanceHistoryPage({ onDashboardUpdated, onAutomationUpdated, onToast }: {
  onDashboardUpdated: (dashboard: DashboardData) => void;
  onAutomationUpdated: (automation: AutomationStatus) => void;
  onToast: (message: string) => void;
}) {
  const [history, setHistory] = useState<ClearanceHistoryView>({ retentionDays: 7, lastCleanupAt: null, entries: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function loadHistory() {
    setLoading(true);
    try {
      const payload = await apiRequest<ClearanceHistoryView>('/api/clearance-history');
      setHistory(payload);
      setSelected((previous) => new Set([...previous].filter((id) => payload.entries.some((entry) => entry.id === id))));
    } catch (error) {
      onToast(error instanceof Error ? error.message : '清关历史加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadHistory(); }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return history.entries;
    return history.entries.filter((entry) => [entry.carrier, entry.carrierCode, entry.billNo, entry.containerNo]
      .some((value) => value.toLowerCase().includes(normalized)));
  }, [history.entries, query]);

  const allSelected = filtered.length > 0 && filtered.every((entry) => selected.has(entry.id));

  function toggleOne(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function updateRetention(retentionDays: 3 | 7) {
    if (retentionDays < history.retentionDays && !window.confirm('切换为 3 天后，超过 3 天的清关历史会立即永久清理。确认继续吗？')) return;
    setBusy(true);
    try {
      const payload = await apiRequest<ClearanceHistoryView>('/api/clearance-history/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ retentionDays }),
      });
      setHistory(payload);
      setSelected(new Set());
      onToast(`清关历史已改为保留 ${retentionDays} 天`);
    } catch (error) {
      onToast(error instanceof Error ? error.message : '保留周期保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function restore(entry: ClearanceHistoryEntryView) {
    if (!window.confirm(`确认将 ${entry.billNo || entry.containerNo} 恢复到船期追踪？恢复后会重新参与人工更新和自动化任务。`)) return;
    setBusy(true);
    try {
      const payload = await apiRequest<{ history: ClearanceHistoryView; dashboard: DashboardData; automation: AutomationStatus }>(`/api/clearance-history/${encodeURIComponent(entry.id)}/restore`, { method: 'POST' });
      setHistory(payload.history);
      onDashboardUpdated(payload.dashboard);
      onAutomationUpdated(payload.automation);
      setSelected((previous) => { const next = new Set(previous); next.delete(entry.id); return next; });
      onToast('记录已恢复到船期追踪，人工标记已清除');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '历史记录恢复失败');
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntries(ids: string[]) {
    if (!ids.length) return;
    if (!window.confirm(`确认永久删除选中的 ${ids.length} 条清关历史？删除后只能从 Excel 备份中恢复。`)) return;
    setBusy(true);
    try {
      const payload = await apiRequest<{ deleted: number; history: ClearanceHistoryView }>('/api/clearance-history/delete-batch', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
      });
      setHistory(payload.history);
      setSelected(new Set());
      onToast(`已删除 ${payload.deleted} 条清关历史`);
    } catch (error) {
      onToast(error instanceof Error ? error.message : '清关历史删除失败');
    } finally {
      setBusy(false);
    }
  }

  async function cleanupExpired() {
    setBusy(true);
    try {
      const payload = await apiRequest<{ deleted: number; history: ClearanceHistoryView }>('/api/clearance-history/cleanup', { method: 'POST' });
      setHistory(payload.history);
      setSelected(new Set());
      onToast(payload.deleted ? `已清理 ${payload.deleted} 条到期历史` : '当前没有到期的清关历史');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '清关历史清理失败');
    } finally {
      setBusy(false);
    }
  }

  return <div className="module-page clearance-history-page">
    <section className="page-heading module-heading">
      <div><p className="eyebrow">CLEARANCE HISTORY</p><h1>清关历史</h1><p>标记为“已清关”的柜子会立即从在途追踪移入这里，并按保留周期自动清理。</p></div>
      <button className="secondary-button" onClick={() => void cleanupExpired()} disabled={busy}><Eraser size={15} />立即清理到期记录</button>
    </section>
    <section className="clearance-summary-grid">
      <article><Archive size={20} /><div><span>历史记录</span><strong>{history.entries.length} 条</strong><small>与当前船期 Excel 分离保存</small></div></article>
      <article><Timer size={20} /><div><span>自动保留周期</span><strong>{history.retentionDays} 天</strong><small>服务每日检查一次到期记录</small></div><select value={history.retentionDays} disabled={busy} onChange={(event) => void updateRetention(Number(event.target.value) as 3 | 7)}><option value={3}>3 天</option><option value={7}>7 天</option></select></article>
      <article><Check size={20} /><div><span>最近清理检查</span><strong>{history.lastCleanupAt ? fullDate(history.lastCleanupAt) : '尚未执行'}</strong><small>只删除超过保留周期的历史</small></div></article>
    </section>
    <section className="module-card clearance-history-card">
      <div className="module-card-header"><div><strong>已清关记录</strong><span>可恢复到船期追踪；自动清理前仍保留完整时间、状态和备注</span></div>{selected.size > 0 && <button className="danger-button" onClick={() => void deleteEntries([...selected])} disabled={busy}><Trash2 size={13} />批量删除 ({selected.size})</button>}</div>
      <div className="history-toolbar"><label className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索船司、提单号或柜号" />{query && <button onClick={() => setQuery('')}><X size={13} /></button>}</label><span>当前显示 {filtered.length} / {history.entries.length} 条</span></div>
      <div className="module-table-wrap"><table className="module-table clearance-history-table"><thead><tr><th className="check-col"><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(filtered.map((entry) => entry.id)))} /></th><th>归档时间</th><th>船司</th><th>提单号</th><th>柜号</th><th>到港时间</th><th>卸船时间</th><th>船只状态</th><th>自动清理</th><th>操作</th></tr></thead><tbody>
        {loading ? <tr><td colSpan={10}><div className="loading-state"><LoaderCircle className="spin" />正在读取清关历史…</div></td></tr> : filtered.length ? filtered.map((entry) => {
          const stateClass = entry.vesselState === '已到港已卸船' ? 'done' : entry.vesselState === '已到港未卸船' ? 'working' : 'pending';
          return <tr key={entry.id} className={selected.has(entry.id) ? 'selected-row' : ''}><td className="check-col"><input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggleOne(entry.id)} /></td><td><div className="update-cell"><span>{fullDate(entry.archivedAt)}</span><small>原 Excel 第 {entry.originalRowNumber} 行</small></div></td><td><div className="carrier-cell"><CarrierMark code={entry.carrierCode} /><div><strong>{carrierLabel(entry.carrierCode, entry.carrier)}</strong><span>{entry.carrierCode}</span></div></div></td><td className="mono">{entry.billNo || '—'}</td><td className="mono">{entry.containerNo || '—'}</td><td><div className="date-cell eta">{formatDateTime(entry.arrivalTime, true)}</div></td><td><div className="date-cell discharge">{formatDateTime(entry.dischargeTime, true)}</div></td><td><span className={`status-badge ${stateClass}`}>{entry.vesselState || '未设置'}</span></td><td><span className="history-expiry">{historyExpiryText(entry.archivedAt, history.retentionDays)}</span></td><td><div className="row-actions"><button className="secondary-button compact-button" onClick={() => void restore(entry)} disabled={busy}><RefreshCw size={13} />恢复</button><button className="row-action danger-action" title="永久删除历史记录" onClick={() => void deleteEntries([entry.id])} disabled={busy}><Trash2 size={14} /></button></div></td></tr>;
        }) : <tr><td colSpan={10}><div className="empty-state"><Archive size={23} /><strong>暂无清关历史</strong><span>在船期追踪中将人工标记改为“已清关”后，记录会自动移入这里</span></div></td></tr>}
      </tbody></table></div>
    </section>
  </div>;
}

function ModulePage({ page, data, automation, authEnabled, currentUser, syncing, onSync, onMark, onDelete, onToggleAutomation, onCreateBackup, onRestoreBackup, onAutomationUpdated, onUpload, onToast, onOpenDetail, onOpenEdit, onOpenManual }: {
  page: Exclude<PageId, 'overview' | 'history'>;
  data: DashboardData | null;
  automation: AutomationStatus | null;
  authEnabled: boolean;
  currentUser: AuthSession['user'];
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
  const [managedUsers, setManagedUsers] = useState<AuthManagedUser[]>([]);
  const [userModalMode, setUserModalMode] = useState<'create' | 'reset' | null>(null);
  const [userModalTarget, setUserModalTarget] = useState<AuthManagedUser | null>(null);
  const [userNameInput, setUserNameInput] = useState('');
  const [userPasswordInput, setUserPasswordInput] = useState('');
  const [userRoleInput, setUserRoleInput] = useState<AuthManagedUser['role']>('user');
  const [userSaving, setUserSaving] = useState(false);
  const [webhookInput, setWebhookInput] = useState('');
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [webhookTesting, setWebhookTesting] = useState(false);
  const [browserSaving, setBrowserSaving] = useState(false);
  const [browserCleanup, setBrowserCleanup] = useState(false);
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
  const moduleRefreshSeq = useRef(0);

  async function refreshModuleData() {
    const requestId = ++moduleRefreshSeq.current;
    setModuleLoading(true);
    try {
      const requests: Promise<void>[] = [];
      if (page === 'sources') requests.push(apiRequest<{ carriers: CarrierRuleView[] }>('/api/carriers').then((payload) => setCarrierRules(payload.carriers || [])));
      if (page === 'automation' || page === 'exports') requests.push(apiRequest<{ runs: RunView[] }>('/api/automation/runs').then((payload) => setRuns(payload.runs || [])));
      if (page === 'automation') requests.push(apiRequest<{ tasks: AutomationTask[] }>('/api/automation/tasks').then((payload) => setTasks(payload.tasks || [])));
      if (page === 'exports') requests.push(apiRequest<{ backups: BackupView[] }>('/api/backups').then((payload) => setBackups(payload.backups || [])));
      if (page === 'settings') {
        requests.push(apiRequest<SettingsView>('/api/automation/settings').then((payload) => { setSettingsView(payload); setWebhookInput(''); }));
        if (currentUser?.role === 'admin') requests.push(apiRequest<{ users: AuthManagedUser[] }>('/api/auth/users').then((payload) => setManagedUsers(payload.users || [])));
      }
      const results = await Promise.allSettled(requests);
      if (requestId !== moduleRefreshSeq.current) return;
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed.length === results.length && results.length > 0) onToast('当前模块数据暂时无法加载，请稍后重试');
      else if (failed.length) onToast(`部分模块加载失败（${failed.length} 项），已保留其他可用数据`);
    } catch {
      onToast('当前模块数据暂时无法加载，请稍后重试');
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

  async function cleanupAutomationChrome() {
    if (!window.confirm('确认清理工作台自动化 Chrome？当前没有运行中的查询任务时才可执行；日常使用的 Chrome 不受影响。')) return;
    setBrowserCleanup(true);
    try {
      const payload = await apiRequest<{ automation: AutomationStatus; cleanup?: { orphanedProcesses?: number } }>('/api/automation/browser/cleanup', { method: 'POST' });
      onAutomationUpdated(payload.automation);
      const count = payload.cleanup?.orphanedProcesses || 0;
      onToast(count ? `自动化 Chrome 已清理（${count} 个进程）；下次网页查询会重新打开会话` : '自动化 Chrome 已清理；下次网页查询会重新打开会话');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '自动化 Chrome 清理失败');
    } finally {
      setBrowserCleanup(false);
    }
  }

  function openCreateUser() {
    setUserModalMode('create');
    setUserModalTarget(null);
    setUserNameInput('');
    setUserPasswordInput('');
    setUserRoleInput('user');
  }

  function openResetPassword(user: AuthManagedUser) {
    setUserModalMode('reset');
    setUserModalTarget(user);
    setUserNameInput(user.username);
    setUserPasswordInput('');
  }

  function closeUserModal() {
    if (!userSaving) setUserModalMode(null);
  }

  async function saveManagedUser() {
    setUserSaving(true);
    try {
      const payload = userModalMode === 'create'
        ? await apiRequest<{ users: AuthManagedUser[] }>('/api/auth/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: userNameInput, password: userPasswordInput, role: userRoleInput }) })
        : await apiRequest<{ users: AuthManagedUser[] }>(`/api/auth/users/${encodeURIComponent(userModalTarget!.id)}/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: userPasswordInput }) });
      setManagedUsers(payload.users || []);
      setUserModalMode(null);
      onToast(userModalMode === 'create' ? '账号已创建' : '密码已重置');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '账号操作失败');
    } finally {
      setUserSaving(false);
    }
  }

  async function updateManagedUser(user: AuthManagedUser, patch: { role?: AuthManagedUser['role']; enabled?: boolean }) {
    try {
      const payload = await apiRequest<{ users: AuthManagedUser[] }>(`/api/auth/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      setManagedUsers(payload.users || []);
      onToast('账号权限已更新');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '账号更新失败');
    }
  }

  async function deleteManagedUser(user: AuthManagedUser) {
    if (!window.confirm(`确认删除账号“${user.username}”？删除后无法恢复。`)) return;
    try {
      const payload = await apiRequest<{ users: AuthManagedUser[] }>(`/api/auth/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
      setManagedUsers(payload.users || []);
      onToast('账号已删除');
    } catch (error) {
      onToast(error instanceof Error ? error.message : '账号删除失败');
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
      const payload = await apiRequest<{ runs: RunView[]; tasks: AutomationTask[]; dashboard: DashboardData; automation: AutomationStatus }>('/api/automation/tasks/run-batch', { method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey('task-batch') }, body: JSON.stringify({ ids: orderedTaskIds }) });
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
      const payload = await apiRequest<{ tasks: AutomationTask[]; dashboard: DashboardData; automation: AutomationStatus }>(`/api/automation/tasks/${encodeURIComponent(task.id)}/run`, { method: 'POST', headers: { 'x-idempotency-key': idempotencyKey(`task-${task.id}`) } });
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
    sources: ['DATA SOURCES', '数据源管理', '查看系统内置船司规则、接口状态和网页采集能力；订单更新请在船期追踪中执行。'],
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

    {page === 'sources' && <><section className="module-card source-explainer"><div className="module-card-header"><div><strong>数据源管理的作用</strong><span>这里维护船司识别规则与解析器状态，不直接保存订单。</span></div><span className="integration-tag ready">系统内置</span></div><p>每个船司的提单前缀、查询号码规则、官方接口和网页备用方式都在这里统一展示。数据源属于系统能力，不能像订单一样删除；如果某个官网暂时不可用，会在这里显示异常，订单更新仍请前往“船期追踪”执行。</p></section><section className="carrier-grid">
      {carrierRules.map((rule) => {
        const integrationLabel = { ready: '已接入', blocked: '浏览器仍受风控', limited: '浏览器备用已接入', error: '官网接口异常' }[rule.integration];
        return <article className="carrier-rule-card" key={`${rule.code}-${rule.name}`}><div className="carrier-rule-head"><CarrierMark code={rule.code} /><div><strong>{carrierLabel(rule.code, rule.name)}</strong><span>{rule.prefix} · {rule.code}</span></div><span className={`integration-tag ${rule.integration}`}>{integrationLabel}</span></div><dl><div><dt>查询号码</dt><dd>{rule.removePrefix ? `去除 ${rule.code === 'SMLINE' ? 'SMLM' : rule.prefix} 前缀` : '保留完整提单号'}</dd></div><div><dt>查询方式</dt><dd>{rule.queryMode === 'bill-and-container' ? '提单号 + 柜号均需成功' : rule.queryMode === 'bill-or-container' ? '提单号 / 柜号任一成功' : rule.queryMode === 'bill-then-container' ? '提单失败后改查柜号' : '仅提单号'}</dd></div></dl><p className="integration-message">{rule.integrationMessage}</p><div className="carrier-rule-actions"><a href={rule.url} target="_blank" rel="noreferrer">打开船司查询页面<ExternalLink size={13} /></a><span className="source-built-in">内置规则 · 不可删除</span></div></article>;
      })}
    </section></>}

    {page === 'automation' && <>
      {tasks.length ? <section className="module-card task-manager"><div className="module-card-header"><div><strong>自定义自动化任务</strong><span>可按船司或单条船期创建任务；批量执行时按列表顺序逐条完成</span></div><div className="task-toolbar"><button className="secondary-button" onClick={() => setTaskModalOpen(true)}><Save size={14} />新建任务</button>{selectedTasks.size > 0 && <><button className="secondary-button" onClick={runSelectedTasks} disabled={taskRunning}><RefreshCw size={14} />按顺序执行 ({selectedTasks.size})</button><button className="danger-button" onClick={deleteSelectedTasks}><Trash2 size={13} />批量删除</button></>}</div></div><div className="task-list">{tasks.map((task) => <div className={`task-row ${selectedTasks.has(task.id) ? 'selected-row' : ''}`} key={task.id}><input type="checkbox" checked={selectedTasks.has(task.id)} onChange={() => toggleTask(task.id)} /><div className="task-main"><strong>{task.name}</strong><span>{task.scope === 'all' ? '全部未完成记录' : task.scope === 'carrier' ? `船司：${task.carrierCodes.map((code) => carrierLabel(code)).join('、')}` : `单条船期：${task.shipmentIds.length} 条`} · {task.scheduleTime ? `每天 ${task.scheduleTime}` : '仅手动执行'} · 创建于 {fullDate(task.createdAt)}</span></div><span className={`enabled-pill ${task.enabled ? '' : 'disabled'}`}>{task.enabled ? '已启用' : '已停用'}</span><button className="text-action-button" onClick={() => runTask(task)} disabled={!task.enabled || taskRunning}><RefreshCw size={13} />立即执行</button><button className="row-action" title={task.enabled ? '停用任务' : '启用任务'} onClick={async () => { try { const payload = await apiRequest<{ tasks: AutomationTask[] }>(`/api/automation/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !task.enabled }) }); setTasks(payload.tasks || []); } catch (error) { onToast(error instanceof Error ? error.message : '任务设置保存失败'); } }}><Clock3 size={14} /></button><button className="row-action danger-action" title="删除任务" onClick={async () => { if (!window.confirm(`确认删除任务“${task.name}”？`)) return; setDeletingTask(task.id); try { const payload = await apiRequest<{ tasks: AutomationTask[] }>('/api/automation/tasks/delete-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [task.id] }) }); setTasks(payload.tasks || []); setSelectedTasks((previous) => { const next = new Set(previous); next.delete(task.id); return next; }); onToast('任务已删除'); } catch (error) { onToast(error instanceof Error ? error.message : '删除任务失败'); } finally { setDeletingTask(''); } }} disabled={deletingTask === task.id}><Trash2 size={14} /></button></div>)}</div></section> : <button className="task-entry-button" type="button" onClick={() => setTaskModalOpen(true)}><span className="task-entry-icon"><Save size={17} /></span><span><strong>自定义自动化任务</strong><small>按船司、单条船期或全部未完成数据创建任务</small></span><ChevronRight size={18} /></button>}
      <RunHistory runs={runs} selected={selectedRuns} onToggle={toggleRun} onDelete={deleteRun} onDeleteSelected={deleteSelectedRuns} />
      {taskModalOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => !taskSaving && setTaskModalOpen(false)}><section className="task-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">CUSTOM AUTOMATION</p><h2>新建自动化任务</h2><p>选择数据范围和每日执行时间；时间留空时仅支持手动执行。</p></div><button className="drawer-close" onClick={() => setTaskModalOpen(false)} disabled={taskSaving}><X size={19} /></button></div><label className="setting-field"><span>任务名称</span><input value={taskName} onChange={(event) => setTaskName(event.target.value)} placeholder="例如：上午重点船司更新" /></label><label className="setting-field"><span>每日执行时间（可选）</span><input type="time" value={taskScheduleTime} onChange={(event) => setTaskScheduleTime(event.target.value)} /></label><label className="setting-field"><span>更新范围</span><select value={taskScope} onChange={(event) => { setTaskScope(event.target.value as AutomationTask['scope']); setTaskCarrierCodes([]); setTaskShipmentIds([]); }}><option value="all">全部未完成记录</option><option value="carrier">指定船司</option><option value="shipment">指定船期</option></select></label>{taskScope === 'carrier' && <div className="task-choice-grid">{Array.from(new Set((data?.shipments || []).map((item) => item.carrierCode))).map((code) => <label key={code}><input type="checkbox" checked={taskCarrierCodes.includes(code)} onChange={(event) => setTaskCarrierCodes((previous) => event.target.checked ? [...previous, code] : previous.filter((item) => item !== code))} />{carrierLabel(code)}</label>)}</div>}{taskScope === 'shipment' && <div className="task-choice-grid shipment-choice-grid">{(data?.shipments || []).map((item) => <label key={item.id}><input type="checkbox" checked={taskShipmentIds.includes(item.id)} onChange={(event) => setTaskShipmentIds((previous) => event.target.checked ? [...previous, item.id] : previous.filter((id) => id !== item.id))} /><span>{carrierLabel(item.carrierCode, item.carrier)} · {item.billNo}</span></label>)}</div>}<div className="modal-actions"><button className="secondary-button" onClick={() => setTaskModalOpen(false)} disabled={taskSaving}>取消</button><button className="primary-button" onClick={createTask} disabled={taskSaving}>{taskSaving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{taskSaving ? '保存中…' : '创建任务'}</button></div></section></div>}
    </>}

    {page === 'exports' && <>
      <section className="export-summary-grid"><article><FileCheck2 size={20} /><div><span>当前工作簿</span><strong>{automation?.workbook?.records || 0} 条记录</strong><small>{automation?.workbook ? fullDate(automation.workbook.modifiedAt) : '尚未导入'}</small></div><a href={automation?.workbook ? '/api/workbooks/current' : '#'} onClick={(event) => { if (!automation?.workbook) { event.preventDefault(); onToast('请先导入 Excel 或新增单号'); } }}>下载<Download size={14} /></a></article><article><Archive size={20} /><div><span>备份文件</span><strong>{backups.length} 个文件</strong><small>更新前自动生成，也可手动创建</small></div><button className="secondary-button backup-create" onClick={async () => { await onCreateBackup(); await refreshModuleData(); }} disabled={!automation?.workbook}>创建备份</button></article><article><FileSpreadsheet size={20} /><div><span>运行记录</span><strong>{runs.length} 次</strong><small>最多保留最近 30 次</small></div></article></section>
      <section className="module-card"><div className="module-card-header"><div><strong>备份文件</strong><span>按时间倒序排列；恢复会先备份当前文件，删除后不可恢复</span></div>{backups.length > 0 && <div className="backup-toolbar"><label><input type="checkbox" checked={selectedBackups.size === backups.length} onChange={(event) => setSelectedBackups(event.target.checked ? new Set(backups.map((item) => item.name)) : new Set())} />全选</label>{selectedBackups.size > 0 && <button className="danger-button" onClick={deleteSelectedBackups} disabled={Boolean(deletingBackup)}><Trash2 size={13} />批量删除 ({selectedBackups.size})</button>}</div>}</div><div className="backup-list">{backups.length ? backups.map((backup) => <div className={selectedBackups.has(backup.name) ? 'selected-row' : ''} key={backup.name}><input type="checkbox" checked={selectedBackups.has(backup.name)} onChange={() => toggleBackup(backup.name)} /><div className="backup-icon"><Archive size={17} /></div><div className="backup-main"><strong>{backup.name}</strong><span>{backup.reason} · {(backup.size / 1024).toFixed(1)} KB · {fullDate(backup.createdAt)}</span></div><div className="backup-actions"><a href={`/api/backups/${encodeURIComponent(backup.name)}`}><Download size={15} />下载</a><button className="restore-button" onClick={async () => { await onRestoreBackup(backup.name); await refreshModuleData(); }} disabled={!automation?.workbook || Boolean(deletingBackup)}>恢复</button><button className="danger-button" onClick={() => deleteBackup(backup.name)} disabled={Boolean(deletingBackup)}><Trash2 size={13} />{deletingBackup === backup.name ? '删除中…' : '删除'}</button></div></div>) : <div className="empty-module">尚无备份文件，执行一次更新或手动创建备份后会显示。</div>}</div></section>
    </>}

    {page === 'settings' && <section className="settings-grid">
      <article className="settings-card"><div className="settings-card-title"><Server size={19} /><div><strong>采集服务</strong><span>本地服务器运行状态</span></div><span className="setting-ok">运行中</span></div><div className="setting-row"><span>运行模式</span><strong>真实官网数据</strong></div><div className="setting-row"><span>支持船司规则</span><strong>{automation?.supportedCarriers || 15} 家</strong></div><div className="setting-row"><span>结构化数据库</span><strong>{automation?.databaseConfigured ? 'PostgreSQL 已启用' : '本地文件模式'}</strong></div><div className="setting-row"><span>服务端口</span><strong>{window.location.port || '8787'}</strong></div></article>
      <article className="settings-card"><div className="settings-card-title"><Timer size={19} /><div><strong>自定义任务调度</strong><span>仅执行用户创建并设置时间的任务</span></div><span className={automation?.enabled ? 'setting-ok' : 'setting-warn'}>{automation?.enabled ? '已启用' : '已停用'}</span></div><div className="setting-row"><span>自定义调度开关</span><label className="setting-toggle"><span>{automation?.enabled ? '启用' : '停用'}</span><input type="checkbox" checked={Boolean(automation?.enabled)} onChange={(event) => onToggleAutomation(event.target.checked)} /><span className="switch-slider" /></label></div><div className="setting-row"><span>执行时区</span><strong>{automation?.timezone || 'Asia/Shanghai'}</strong></div><div className="setting-row"><span>执行时间</span><strong>由每条自定义任务单独设置</strong></div></article>
      <article className="settings-card"><div className="settings-card-title"><Globe2 size={19} /><div><strong>官方接口 + 网页模拟点击</strong><span>官方接口优先，失败后才使用浏览器备用通道</span></div><span className={settingsView?.browserAutomationEnabled ? 'setting-ok' : 'setting-warn'}>{settingsView?.browserAutomationEnabled ? '已启用' : '已停用'}</span></div><div className="setting-row"><span>官方接口</span><strong>按船司适配器自动选择</strong></div><div className="setting-row"><span>网页模拟点击</span><label className="setting-toggle"><span>{settingsView?.browserAutomationEnabled ? '启用' : '停用'}</span><input type="checkbox" checked={Boolean(settingsView?.browserAutomationEnabled)} disabled={browserSaving} onChange={(event) => saveBrowserAutomation(event.target.checked)} /><span className="switch-slider" /></label></div><div className="setting-row"><span>运行方式</span><strong>系统 Chrome · 串行查询</strong></div><div className="setting-row"><span>并发策略</span><strong>单线程串行，降低风控</strong></div><div className="setting-help">页面必须同时显示对应提单号/柜号和明确时间字段才会写入；验证码、空页面或无法核验的数据仍按失败处理，并保存证据截图。</div></article>
      <article className="settings-card"><div className="settings-card-title"><Eraser size={19} /><div><strong>自动化 Chrome 管理</strong><span>清理工作台创建的浏览器会话进程</span></div><span className="setting-ok">管理员操作</span></div><div className="setting-help">只清理工作台的自动化浏览器，不会关闭你日常使用的 Chrome。执行前请确认没有正在运行的查询任务；已保存的船司 Cookie 和验证配置仍保留在本地配置目录。</div><div className="setting-actions"><button className="secondary-button" onClick={() => void cleanupAutomationChrome()} disabled={browserCleanup || Boolean(automation?.running)}><Eraser size={15} />{browserCleanup ? '清理中…' : '清理自动化 Chrome'}</button></div></article>
      <article className="settings-card wecom-settings"><div className="settings-card-title"><MessageSquare size={19} /><div><strong>企业微信通知</strong><span>任务完成后发送汇总</span></div><span className={settingsView?.notificationConfigured || automation?.notificationConfigured ? 'setting-ok' : 'setting-warn'}>{settingsView?.notificationConfigured || automation?.notificationConfigured ? '已配置' : '待配置'}</span></div><div className="setting-help">可直接在这里保存企业微信机器人 Webhook。密钥只保存在本机服务端，不会回显完整地址。</div><label className="setting-field"><span>机器人 Webhook</span><input type="url" value={webhookInput} onChange={(event) => setWebhookInput(event.target.value)} placeholder={settingsView?.webhookPreview || 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'} /></label><div className="setting-preview">{settingsView?.notificationConfigured ? `当前配置：${settingsView.webhookPreview}` : '当前未配置企业微信通知'}</div><div className="setting-actions"><button className="secondary-button" onClick={testWebhook} disabled={webhookTesting || (!webhookInput.trim() && !settingsView?.notificationConfigured)}><Send size={15} />{webhookTesting ? '发送中…' : '发送测试'}</button><button className="primary-button" onClick={saveWebhook} disabled={webhookSaving}>{webhookSaving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{webhookSaving ? '保存中…' : '保存配置'}</button></div></article>
    </section>}
    {page === 'settings' && currentUser?.role === 'admin' && <section className="settings-card account-settings-card"><div className="settings-card-title"><Users size={19} /><div><strong>账号与权限</strong><span>管理工作台登录账号、角色和使用状态</span></div><button className="primary-button compact-button" onClick={openCreateUser} disabled={!authEnabled}><UserPlus size={14} />新增账号</button></div>{!authEnabled && <div className="setting-help account-warning">当前处于免登录兼容模式。请在 `.env` 设置 `AUTH_ENABLED=true` 并重启服务后，才能启用账号登录和新增账号。</div>}<div className="account-table-wrap"><table className="account-table"><thead><tr><th>账号</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{managedUsers.length ? managedUsers.map((user) => <tr key={user.id}><td><strong>{user.username}</strong>{user.id === currentUser.id && <span className="account-self">当前账号</span>}</td><td><select value={user.role} disabled={user.id === currentUser.id || !authEnabled} onChange={(event) => void updateManagedUser(user, { role: event.target.value as AuthManagedUser['role'] })}><option value="admin">管理员</option><option value="user">普通用户</option></select></td><td><button className={`account-status ${user.enabled ? 'enabled' : 'disabled'}`} disabled={!authEnabled} onClick={() => void updateManagedUser(user, { enabled: !user.enabled })}>{user.enabled ? '已启用' : '已停用'}</button></td><td>{fullDate(user.createdAt)}</td><td><div className="account-actions"><button className="text-action-button" onClick={() => openResetPassword(user)} disabled={!authEnabled}><KeyRound size={13} />重置密码</button>{user.id !== currentUser.id && <button className="row-action danger-action" title="删除账号" onClick={() => void deleteManagedUser(user)} disabled={!authEnabled}><Trash2 size={14} /></button>}</div></td></tr>) : <tr><td colSpan={5}><div className="empty-module">暂无账号，请先配置登录后新增账号。</div></td></tr>}</tbody></table></div></section>}
    {userModalMode && <div className="modal-backdrop" role="presentation" onMouseDown={closeUserModal}><section className="settings-modal account-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">ACCOUNT MANAGEMENT</p><h2>{userModalMode === 'create' ? '新增账号' : '重置密码'}</h2><p>{userModalMode === 'create' ? '创建后账号可以立即登录工作台。' : `为 ${userModalTarget?.username} 设置新密码。`}</p></div><button className="drawer-close" onClick={closeUserModal} disabled={userSaving}><X size={19} /></button></div>{userModalMode === 'create' && <><label className="setting-field"><span>用户名</span><input autoFocus value={userNameInput} onChange={(event) => setUserNameInput(event.target.value)} placeholder="2-32 位字符" /></label><label className="setting-field"><span>角色</span><select value={userRoleInput} onChange={(event) => setUserRoleInput(event.target.value as AuthManagedUser['role'])}><option value="user">普通用户</option><option value="admin">管理员</option></select></label></>}<label className="setting-field"><span>新密码</span><input type="password" autoFocus={userModalMode === 'reset'} value={userPasswordInput} onChange={(event) => setUserPasswordInput(event.target.value)} placeholder="至少 12 位" /></label><div className="setting-help">密码长度要求 12-128 位，建议使用随机密码。</div><div className="modal-actions"><button className="secondary-button" onClick={closeUserModal} disabled={userSaving}>取消</button><button className="primary-button" onClick={() => void saveManagedUser()} disabled={userSaving || (userModalMode === 'create' && !userNameInput.trim()) || userPasswordInput.length < 12}>{userSaving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{userSaving ? '保存中…' : '保存'}</button></div></section></div>}
  </div>;
}

function RunHistory({ runs, selected, onToggle, onDelete, onDeleteSelected }: { runs: RunView[]; selected: Set<string>; onToggle: (id: string) => void; onDelete: (id: string) => void; onDeleteSelected: () => Promise<void> }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggleExpanded(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  return <section className="module-card"><div className="module-card-header"><div><strong>任务运行记录</strong><span>最近 {runs.length} 次 · 详细失败信息默认折叠，点击展开查看</span></div>{selected.size > 0 && <button className="danger-button" onClick={onDeleteSelected}><Trash2 size={13} />批量删除 ({selected.size})</button>}</div><div className="run-list">{runs.length ? runs.map((run) => { const isExpanded = expanded.has(run.id); return <article className="run-entry" key={run.id}><div className="run-summary"><input type="checkbox" checked={selected.has(run.id)} onChange={() => onToggle(run.id)} /><span className={`run-state ${run.failed ? 'failed' : 'success'}`}>{run.failed ? <CircleAlert size={15} /> : <Check size={15} />}</span><div className="run-main"><strong>{run.reason === 'scheduled' ? '定时更新' : '手动更新'}</strong><span>{run.id} · {fullDate(run.finishedAt)}</span></div><div className="run-stats"><span>查询 <strong>{run.total}</strong></span><span>成功 <strong>{run.success}</strong></span><span>未完成 <strong>{run.unfinished}</strong></span><span className={run.failed ? 'danger-text' : ''}>失败 <strong>{run.failed}</strong></span></div><span className={`notify-state ${run.notification}`}>{run.notification === 'sent' ? '通知已发送' : run.notification === 'failed' ? '通知失败' : '未配置通知'}</span><button className="run-expand" onClick={() => toggleExpanded(run.id)} aria-expanded={isExpanded}>{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{isExpanded ? '收起详情' : '展开详情'}</button><button className="row-action danger-action" title="删除运行记录" onClick={() => onDelete(run.id)}><Trash2 size={14} /></button></div>{isExpanded && <div className="run-failures">{run.failedDetails?.length ? run.failedDetails.map((detail) => <div key={`${run.id}-${detail.billNo}-${detail.containerNo}`}><span className="failure-category">{detail.category}</span><strong>{detail.carrier} · {detail.billNo}</strong><span>柜号：{detail.containerNo || '未提供'}</span><p>{detail.reason}</p><a className="evidence-link" href={detail.sourceUrl} target="_blank" rel="noreferrer" onClick={() => navigator.clipboard?.writeText(detail.billNo).catch(() => undefined)}>打开官网重试<ExternalLink size={12} /></a>{detail.evidencePath ? <a className="evidence-link" href={detail.evidencePath} target="_blank" rel="noreferrer">查看浏览器失败截图<ExternalLink size={12} /></a> : null}</div>) : <div className="run-detail-empty">本次运行没有详细失败信息。</div>}</div>}</article>; }) : <div className="empty-module">尚无运行记录。</div>}</div></section>;
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
    tracking: '追踪中的货物', arriving: '未来 48 小时到港', working: '正在码头作业', completed: '已完成卸船', changed: '数据有异常',
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

function SyncProgress({ progress, queuedRuns }: { progress: NonNullable<AutomationStatus['currentRun']>; queuedRuns: number }) {
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
    <div className="sync-progress-foot"><span>成功 {progress.success}</span><span>失败 {progress.failed}</span><span>跳过 {progress.skipped}</span>{queuedRuns > 0 && <span>排队 {queuedRuns}</span>}<span className="sync-current">{progress.currentBills.length ? `当前：${progress.currentBills.slice(0, 3).map((item) => `${item.carrier} ${item.billNo}`).join('、')}${progress.currentBills.length > 3 ? '…' : ''}` : '正在切换下一条'}</span></div>
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

function RouteTimeline({ route, detail }: { route?: string | null; detail?: Shipment['trackingDetail'] }) {
  const stops = detail?.routeStops?.length
    ? detail.routeStops
    : (route || '').split(/\s*→\s*/).map((name) => ({ name: name.trim(), role: 'unknown' as const })).filter((stop) => stop.name);
  if (!stops.length) return null;
  const roleLabels: Record<string, string> = { origin: '起始地', loading: '始发港', transshipment: '中转港', discharge: '目的港', delivery: '目的地', unknown: '线路节点' };
  const normalized = (value: string | null) => (value || '').toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
  const events = detail?.events || [];
  const eventStopCandidates = (event: (typeof events)[number]) => {
    const location = normalized(event.location);
    if (!location) return [];
    const exact = stops.flatMap((stop, index) => normalized(stop.name) === location ? [index] : []);
    if (exact.length) return exact;
    return stops
      .map((stop, index) => ({ index, name: normalized(stop.name) }))
      .filter((item) => item.name && (location.includes(item.name) || item.name.includes(location)))
      .sort((left, right) => right.name.length - left.name.length)
      .map((item) => item.index);
  };
  // 部分线路会在提柜后返回原港还箱。同一地点可以出现多次，按官网事件顺序
  // 向后匹配线路节点，避免把最后一次还箱错误归到第一次到港节点。
  let routeCursor = 0;
  const eventStopIndexes = events.map((event) => {
    const candidates = eventStopCandidates(event);
    if (!candidates.length) return -1;
    const matched = candidates.find((index) => index >= routeCursor) ?? candidates.at(-1)!;
    routeCursor = Math.max(routeCursor, matched);
    return matched;
  });
  const eventsFor = (index: number) => events.filter((_, eventIndex) => eventStopIndexes[eventIndex] === index);
  const unassignedEvents = events.filter((_, eventIndex) => eventStopIndexes[eventIndex] < 0);
  const modeLabels: Record<string, string> = { ocean: '海运', rail: '铁路', truck: '卡车', terminal: '场站', unknown: '其他' };
  const renderEvent = (event: (typeof events)[number], eventIndex: number) => {
    const equipment = [event.facility, event.vesselName && `${event.vesselName}${event.voyageNo ? ` / ${event.voyageNo}` : ''}`].filter(Boolean).join(' · ');
    return <div className={`route-event ${event.cargoState}`} key={`${event.label}-${event.time || 'na'}-${eventIndex}`}><div><b>{event.actual ? '实际' : '预计'}</b><em>{event.cargoState === 'laden' ? '有货' : event.cargoState === 'empty' ? '空箱' : '状态未知'}</em>{event.transportMode && <i>{modeLabels[event.transportMode]}</i>}</div><strong>{event.label}</strong><span>{event.location ? `${event.location} · ` : ''}{event.timeText || (event.time ? formatDateTime(event.time) : '时间未提供')}</span>{equipment && <small>{equipment}</small>}</div>;
  };
  return <section className="route-timeline"><div className="route-timeline-heading"><MapPin size={17} /><div><strong>官网完整运行线路</strong><span>{detail ? `已采集 ${detail.events.length} 条官网轨迹事件` : '按船司官网轨迹整理'}</span></div></div>{detail?.facts?.length ? <div className="tracking-facts">{detail.facts.map((fact) => <div key={`${fact.label}-${fact.value}`}><span>{fact.label}</span><strong>{fact.value}</strong></div>)}</div> : null}<div className="route-stops">{stops.map((stop, index) => <div className={`route-stop ${index === stops.length - 1 && !unassignedEvents.length ? 'last' : ''}`} key={`${stop.name}-${index}`}><span className="route-stop-dot"><MapPin size={11} /></span><div className="route-stop-content"><strong>{stop.name}</strong><span>{roleLabels[stop.role] || roleLabels.unknown}</span>{eventsFor(index).map(renderEvent)}</div></div>)}{unassignedEvents.length > 0 && <div className="route-stop last"><span className="route-stop-dot"><MapPin size={11} /></span><div className="route-stop-content"><strong>其他官网轨迹事件</strong><span>未能匹配到线路节点，保留原始地点</span>{unassignedEvents.map(renderEvent)}</div></div>}</div></section>;
}
