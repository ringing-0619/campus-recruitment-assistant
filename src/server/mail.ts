import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Store } from './db.js';
import type { CandidateService } from './candidates.js';
import { isLikelyRecruitmentMail, parseRecruitmentMessage } from './parser.js';
import { readMailCredential } from './keychain.js';
import { normalizeMarket } from '../shared/types.js';

const DEFAULT_INITIAL_DELAY_MS = 2_000;
const DEFAULT_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_DELAYS_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000] as const;
export const MAIL_RULES_VERSION = '2026-11-01-subject-role-deadline-v5';

export interface MailSyncOptions {
  initialDelayMs?: number;
  syncIntervalMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => Date;
  readCredential?: typeof readMailCredential;
  createClient?: (address: string, pass: string) => ImapFlow;
  onBackgroundError?: (message: string) => void;
}

export class MailSyncService {
  private timer?: NodeJS.Timeout;
  private started = false;
  private running = false;
  private retryAttempt = 0;
  private nextRetryAt: string | null = null;
  private readonly initialDelayMs: number;
  private readonly syncIntervalMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly now: () => Date;
  private readonly credentialReader: typeof readMailCredential;
  private readonly clientFactory?: (address: string, pass: string) => ImapFlow;
  private readonly onBackgroundError?: (message: string) => void;
  connected = false;
  lastError: string | null = null;
  lastErrorAt: string | null = null;

  constructor(
    private store: Store,
    private candidates: CandidateService,
    options: MailSyncOptions = {},
  ) {
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.retryDelaysMs = options.retryDelaysMs?.length
      ? options.retryDelaysMs
      : DEFAULT_RETRY_DELAYS_MS;
    this.now = options.now ?? (() => new Date());
    this.credentialReader = options.readCredential ?? readMailCredential;
    this.clientFactory = options.createClient;
    this.onBackgroundError = options.onBackgroundError;
  }

  start() {
    this.started = true;
    this.schedule(this.configured() ? this.initialDelayMs : this.syncIntervalMs, false);
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRetryAt = null;
  }
  configured() {
    return Boolean(this.store.getSetting('mail_address'));
  }

  configurationChanged() {
    this.retryAttempt = 0;
    this.nextRetryAt = null;
    if (!this.configured()) {
      this.connected = false;
      this.lastError = null;
      this.lastErrorAt = null;
    }
    if (this.started)
      this.schedule(this.configured() ? this.initialDelayMs : this.syncIntervalMs, false);
  }

  status() {
    return {
      configured: this.configured(),
      connected: this.connected,
      lastSyncAt: this.store.getSetting('mail_last_sync_at') || null,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      nextRetryAt: this.nextRetryAt,
      retryAttempt: this.retryAttempt,
      syncing: this.running,
      address: this.store.getSetting('mail_address') || null,
    };
  }

  async test(address: string) {
    const authCode = await this.credentialReader(address);
    const client = this.createClient(address, authCode);
    try {
      await client.connect();
      await client.mailboxOpen('INBOX');
      this.connected = true;
      this.lastError = null;
      this.lastErrorAt = null;
      return true;
    } catch (error) {
      this.recordError(error);
      throw error;
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async sync() {
    if (this.running) return { skipped: true, processed: 0 };
    if (!this.configured()) {
      this.schedule(this.syncIntervalMs, false);
      return { skipped: true, processed: 0 };
    }
    this.running = true;
    const market = normalizeMarket(this.store.getSetting('mail_market'));
    const address = this.store.getSetting('mail_address')!;
    let client: ImapFlow | undefined;
    try {
      client = this.createClient(address, await this.credentialReader(address));
      await client.connect();
      const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
      this.connected = true;
      const uidValidity = String(mailbox.uidValidity);
      const savedValidity = this.store.getSetting('mail_uid_validity');
      let lastUid = Number(this.store.getSetting('mail_last_uid') || 0);
      if (savedValidity && savedValidity !== uidValidity) lastUid = 0;
      const recheck = this.store.getSetting('mail_rules_version') !== MAIL_RULES_VERSION;
      const ids =
        lastUid > 0 && !recheck
          ? await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })
          : await client.search(
              { since: new Date(this.now().getTime() - 90 * 864e5) },
              { uid: true },
            );
      let processed = 0;
      const sorted = [...(ids || [])]
        .filter((uid) => recheck || !lastUid || uid > lastUid)
        .sort((a, b) => a - b);
      for (const uid of sorted) {
        const header = await client.fetchOne(
          uid,
          { uid: true, envelope: true, size: true },
          { uid: true },
        );
        if (!header) continue;
        const subject = header.envelope?.subject || '';
        const from =
          header.envelope?.from
            ?.map((item) => `${item.name || ''} <${item.address || ''}>`)
            .join(', ') || '';
        const advance = () => {
          lastUid = Math.max(lastUid, Number(header.uid || uid));
          // 每封处理成功才推进游标；正文下载/解析异常时，下次仍会重试该封。
          if (!recheck) {
            this.store.setSetting('mail_uid_validity', uidValidity);
            this.store.setSetting('mail_last_uid', String(lastUid));
          }
        };
        const headerRef = header.envelope?.messageId ? `mail:${header.envelope.messageId}` : '';
        const previous = headerRef ? this.store.emailCandidatesByRef(headerRef) : [];
        const ignorePreviousPending = () =>
          previous
            .filter((item) => item.status === 'pending')
            .forEach((item) => this.store.setCandidateStatus(item.id, 'ignored'));
        if (!isLikelyRecruitmentMail(subject, from)) {
          if (recheck) ignorePreviousPending();
          advance();
          continue;
        }
        // Only likely recruitment mail is fetched. It is parsed in memory and never persisted verbatim.
        // Oversized messages are skipped to avoid pulling attachment-heavy messages.
        if (Number(header.size || 0) > 2_000_000) {
          advance();
          continue;
        }
        const full = await client.fetchOne(uid, { source: true, uid: true }, { uid: true });
        if (!full || !full.source) throw new Error('邮件正文下载未完成，请稍后重试');
        const parsed = await simpleParser(full.source, {
          skipImageLinks: true,
          skipTextToHtml: true,
          maxHtmlLengthToParse: 512_000,
        });
        const messageId =
          parsed.messageId || header.envelope?.messageId || `${address}:${uidValidity}:${uid}`;
        const existing = this.store.emailCandidatesByRef(`mail:${messageId}`);
        const input = parseRecruitmentMessage({
          subject,
          from,
          text: parsed.text || stripHtml(parsed.html || ''),
          receivedAt: header.envelope?.date || this.now(),
          messageId,
          relatedMessageIds: [
            ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
            ...(Array.isArray(parsed.references)
              ? parsed.references
              : parsed.references
                ? [parsed.references]
                : []),
          ],
        });
        if (input) {
          // 回溯重识别沿用原模块，不因用户切换新邮件归属而移动或复制历史申请。
          const markets =
            recheck && existing.length
              ? [...new Set(existing.map((item) => item.market))]
              : [market];
          for (const target of markets) this.candidates.ingest({ ...input, market: target });
          processed++;
        } else {
          existing
            .filter((item) => item.status === 'pending')
            .forEach((item) => this.store.setCandidateStatus(item.id, 'ignored'));
        }
        advance();
      }
      for (const target of ['cn', 'us'] as const) this.candidates.reconcilePendingEmails(target);
      this.store.setSetting('mail_uid_validity', uidValidity);
      this.store.setSetting('mail_last_uid', String(lastUid));
      this.store.setSetting('mail_last_sync_at', new Date().toISOString());
      this.store.setSetting('mail_rules_version', MAIL_RULES_VERSION);
      this.lastError = null;
      this.lastErrorAt = null;
      this.retryAttempt = 0;
      this.nextRetryAt = null;
      this.schedule(this.syncIntervalMs, false);
      return { skipped: false, processed };
    } catch (error) {
      this.recordError(error);
      this.retryAttempt += 1;
      const retryDelay =
        this.retryDelaysMs[Math.min(this.retryAttempt - 1, this.retryDelaysMs.length - 1)];
      this.schedule(retryDelay, true);
      throw error;
    } finally {
      this.running = false;
      if (client) await client.logout().catch(() => undefined);
    }
  }

  private createClient(address: string, pass: string) {
    const client = this.clientFactory
      ? this.clientFactory(address, pass)
      : new ImapFlow({
          host: 'imap.126.com',
          port: 993,
          secure: true,
          auth: { user: address, pass },
          logger: false,
          clientInfo: {
            name: 'CampusRecruitmentAssistant',
            version: '3.0.0',
            vendor: 'Local',
            'support-email': 'support@campus-assistant.local',
          },
        });
    // ImapFlow can emit transport errors after connect() has settled. Without a listener,
    // Node treats the EventEmitter "error" event as fatal and terminates the whole service.
    client.on('error', (error) => this.recordError(error));
    return client;
  }

  private recordError(error: unknown) {
    this.connected = false;
    this.lastError = safeError(error);
    this.lastErrorAt = this.now().toISOString();
  }

  private schedule(delayMs: number, retry: boolean) {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextRetryAt = retry ? new Date(this.now().getTime() + delayMs).toISOString() : null;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runScheduledSync();
    }, delayMs);
    this.timer.unref();
  }

  private async runScheduledSync() {
    try {
      await this.sync();
    } catch {
      try {
        this.onBackgroundError?.(this.lastError || '邮箱同步失败');
      } catch {
        /* Logging must never turn a handled sync failure into a rejected timer callback. */
      }
    }
  }
}

function stripHtml(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ');
}
export function safeError(error: unknown) {
  const details = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const message = [
    details.code,
    details.responseCode,
    details.responseStatus,
    details.response,
    error instanceof Error ? error.message : String(error),
  ]
    .filter((value) => typeof value === 'string' && value)
    .join(' · ');
  const sanitized = message
    .replace(/[A-Z0-9]{16}/gi, '[已隐藏授权码]')
    .replace(/"[^"\r\n]{12,}"/g, '"[已隐藏]"')
    .slice(0, 300);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|\bDNS\b/i.test(sanitized))
    return '无法解析网易邮箱服务器地址（DNS/网络错误），请检查网络或 DNS 设置。';
  if (/ENETUNREACH|EHOSTUNREACH|network\s*(is\s*)?unreachable/i.test(sanitized))
    return '当前网络无法访问网易邮箱服务器，请检查网络连接。';
  if (/unsafe\s*login/i.test(sanitized))
    return '网易阻止了本次登录（Unsafe Login），请在邮箱安全设置中确认第三方客户端登录';
  if (/auth|login|password|credential/i.test(sanitized))
    return `网易拒绝认证：请确认已开启 IMAP，并使用最新生成的客户端授权码。技术信息：${sanitized}`;
  if (/timeout|timedout|ETIMEOUT|ECONN|ECONNRESET|ECONNREFUSED/i.test(sanitized))
    return `连接网易邮箱服务器失败。技术信息：${sanitized}`;
  return sanitized || '网易邮箱返回了未知错误';
}
