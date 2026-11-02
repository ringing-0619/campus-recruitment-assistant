(() => {
  const trackerVersion = '3.6.4';
  if (window.__campusTrackerVersion === trackerVersion) return;
  window.__campusTrackerVersion = trackerVersion;
  const sentResults = new Map();
  let sendQueue = Promise.resolve();
  let sentUnrecognized = false;
  let timer;
  let captureMarket = null;
  const editorPorts = new Set();
  const manualSelections = new Map();
  const previewSnapshots = new Map();
  let contextRefresh = Promise.resolve();
  const contextReady = chrome.runtime
    .sendMessage({ type: 'capture-context', url: location.href })
    .then((context) => {
      if (context?.enabled && ['cn', 'us'].includes(context.market)) captureMarket = context.market;
    })
    .catch(() => undefined);
  const englishSubmissionRule =
    /\b(?:your\s+)?application\s+(?:(?:has been|was)\s+)?(?:successfully\s+)?(?:submitted|received)\b|\b(?:thank you|thanks) for (?:applying|your application)\b|\bwe(?:'ve| have) received your application\b/i;
  const progressMarkerRule =
    /^(?:投递成功|已投递|申请成功|待处理简历|简历筛选(?:中)?|初筛中|筛选中|用人部门筛选|简历评估|测评中|评估中|评估通过|笔试中|面试中|面试(?:已)?完成|被转推荐至其他职位|offer.{0,8}|待入职|已入职|终止入职|流程终止|暂不匹配|不匹配|不合适|未通过|已终止|已结束|已撤回)$/i;
  const detailedProgressRule =
    /^(?:待处理简历|简历筛选(?:中)?|初筛中|筛选中|用人部门筛选|简历评估|测评中|评估中|评估通过|笔试中|面试中|面试(?:已)?完成|被转推荐至其他职位|offer.{0,8}|待入职|已入职|终止入职|流程终止|暂不匹配|不匹配|不合适|未通过|已终止|已结束|已撤回)$/i;
  const cardPositionSelectors =
    '[data-position],[data-position-name],[data-position-title],[data-job-name],[data-job-title],.job-name,.jobName,.position-name,.position-title,.delivery-list-job_name,.applicationListItem-name-text,[class*="job-name"],[class*="job_name"],[class*="jobName"],[class*="job-title"],[class*="jobTitle"],[class*="position-name"],[class*="position_name"],[class*="positionName"],[class*="position-title"],[class*="positionTitle"],[class*="applicationListItem-name"],[class*="application-item-name"],[class*="applicationName"],[class~="item-title"],[class~="title-name"]';
  const applicationCardSelectors =
    '[class*="applicationListItem"],[class*="application-list-item"],[class*="applicationItem"],[class*="application-item"],[class*="applicationCard"],[class*="application-card"],[class*="deliveryItem"],[class*="delivery-item"],[class*="record-card"],[class~="record-item"]';
  const companySelectors =
    '[data-company],[data-company-name],[data-employer],.company-name,.companyName,[class*="company-name"],[class*="companyName"],[class*="company__name"],.company-info__wrap-name,.delivery-item__wrap-company';
  const applicationEvidenceRule =
    /(?:官网(?:主)?投|投递简历|简历投递|投递成功|已投递|申请成功|简历已提交|提交成功|(?:投递|申请)时间[：:]|20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s*\d{1,2}:\d{2})?\s*(?:投递|申请))/i;
  const rules = [
    ['rejection', /未能通过|遗憾地通知|不匹配|淘汰|很遗憾/i, '未通过'],
    ['ended', /流程(?:已)?(?:终止|结束|关闭)|已撤回|终止入职/i, '流程结束'],
    [
      'offer',
      /offer\s*(?:通知|已发放|已收到|阶段|状态)|(?:收到|获得|发放|接受|恭喜.{0,12})(?:正式\s*)?offer|录用通知|录取通知/i,
      'Offer 通知',
    ],
    [
      'ai_interview',
      /(?:AI|人工智能|智能|数字人)[\s在线视频机器人]*(?:面试|面谈)|(?:面试|面谈)[\s在线视频机器人]*(?:AI|人工智能|数字人)|AI\s*interview/i,
      'AI 面试通知',
    ],
    [
      'ai_assessment',
      /(?:AI|人工智能|智能)[\s在线]*(?:测评|评估|测试)|(?:测评|评估|测试)[\s在线]*(?:AI|人工智能)|AI\s*assessment/i,
      'AI 测评通知',
    ],
    ['written_test', /笔试通知|在线笔试|进入笔试/i, '笔试通知'],
    ['assessment', /测评通知|在线测评|人才评估/i, '测评通知'],
    ['interview', /面试通知|面试安排|进入面试|interview/i, '面试通知'],
    [
      'application',
      /投递成功|申请成功|简历已提交|提交成功|感谢您的申请|\b(?:your\s+)?application\s+(?:(?:has been|was)\s+)?(?:successfully\s+)?(?:submitted|received)\b|\b(?:thank you|thanks) for (?:applying|your application)\b|\bwe(?:'ve| have) received your application\b/i,
      '投递成功',
    ],
  ];
  function matchProgress(text) {
    const terminal = rules.slice(0, 3).find(([, rule]) => rule.test(text));
    if (terminal) return terminal;
    // 成功回执常会提到后续 interview，不能据此把当前投递误标为面试。
    if (englishSubmissionRule.test(text)) return rules.find(([type]) => type === 'application');
    return rules.find(([, rule]) => rule.test(text));
  }
  async function inspect(options = {}) {
    await contextReady;
    await contextRefresh;
    if (['cn', 'us'].includes(options.market)) captureMarket = options.market;
    // 打开插件仅预览。未选择/启用的页面不能用默认国内模块抢先自动入库。
    if (!captureMarket) return { ok: true, noChange: true, needsModule: true };
    if (editorPorts.size) return { ok: true, noChange: true, editing: true };
    const text = document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 16000) || '';
    if (/验证码|安全验证|扫码登录/.test(text.slice(0, 1500))) return;
    const detected = detectCurrentCandidates(text);
    if (detected.length)
      return sendCandidates(
        applyManualSelection(eligibleCandidates(detected, captureMarket).items),
      );
    if (isSharedApplicationListRoute()) {
      if (!sentUnrecognized) {
        sentUnrecognized = true;
        chrome.runtime.sendMessage({ type: 'unrecognized-domain', domain: location.hostname });
      }
      return { ok: true, noChange: true, preview: genericPreview(text) };
    }
    const match = matchProgress(`${document.title} ${text}`);
    if (!match) {
      if (options.forceCapture) {
        const preview = genericPreview(text, options.overrides);
        if (preview.company && preview.position)
          return sendCandidate(genericCandidate(text, options.overrides));
        return { ok: false, needsInput: true, preview };
      }
      if (!sentUnrecognized) {
        sentUnrecognized = true;
        chrome.runtime.sendMessage({ type: 'unrecognized-domain', domain: location.hostname });
      }
      return { ok: true, noChange: true, preview: genericPreview(text) };
    }
    const [eventType, , title] = match;
    const company = extractCompany(text);
    const position = extractPosition(text);
    return sendCandidates(
      applyManualSelection(
        eligibleCandidates(
          [
            {
              source: 'website',
              company,
              position,
              recruitmentType: genericRecruitmentType(position),
              url: location.href,
              eventType,
              title,
              occurredAt: new Date().toISOString(),
              application:
                eventType === 'application'
                  ? { appliedAt: new Date().toISOString(), dateSource: 'website' }
                  : undefined,
              evidence: text.slice(0, 280),
              confidence:
                eventType === 'application' && company && position ? 0.92 : company ? 0.9 : 0.72,
            },
          ],
          captureMarket,
        ).items,
      ),
    );
  }
  function detectCurrentCandidates(text, options = {}) {
    const zhaopin = extractZhaopinApplications(options);
    if (zhaopin.length) return zhaopin;
    const alibaba = extractAlibabaApplications(text);
    if (alibaba.length) return alibaba;
    const beisen = extractBeisenApplications(text, options.market);
    if (beisen.length) return beisen;
    const moka = extractMokaApplications(text, options);
    if (moka.length) return moka;
    const applicationCards = extractApplicationCards(options);
    if (applicationCards.length) return applicationCards;
    const yingjiesheng = extractYingjieshengApplication(text);
    if (yingjiesheng)
      return [
        {
          source: 'website',
          company: yingjiesheng.company,
          position: yingjiesheng.position,
          recruitmentType: classifyRecruitment(yingjiesheng.position),
          url: location.href,
          eventType: 'application',
          title: '投递成功',
          occurredAt: new Date().toISOString(),
          evidence: yingjiesheng.evidence,
          confidence: 0.97,
        },
      ];
    return [];
  }
  function candidatesForPreview(text, market = captureMarket || 'cn') {
    return eligibleCandidates(rawCandidatesForPreview(text, market), market);
  }
  function rawCandidatesForPreview(text, market) {
    const detected = detectCurrentCandidates(text, { includePartial: true, market });
    if (detected.length) return detected;
    if (isSharedApplicationListRoute()) return [genericCandidate(text, {}, market)];
    const match = matchProgress(`${document.title} ${text}`);
    if (match) {
      const [eventType, , title] = match;
      const company = extractCompany(text, market),
        position = extractPosition(text);
      return [
        {
          source: 'website',
          company,
          position,
          recruitmentType: genericRecruitmentType(position),
          url: location.href,
          eventType,
          title,
          occurredAt: new Date().toISOString(),
          application:
            eventType === 'application'
              ? { appliedAt: new Date().toISOString(), dateSource: 'website' }
              : undefined,
          evidence: text.slice(0, 280),
          confidence:
            eventType === 'application' && company && position ? 0.92 : company ? 0.9 : 0.72,
        },
      ];
    }
    return [genericCandidate(text, {}, market)];
  }
  function genericCandidate(text, overrides = {}, market = captureMarket || 'cn') {
    const preview = genericPreview(text, overrides, market);
    return {
      source: 'website',
      company: preview.company,
      position: preview.position,
      recruitmentType: genericRecruitmentType(preview.position),
      url: location.href,
      eventType: 'application',
      title: '投递成功',
      occurredAt: new Date().toISOString(),
      evidence: preview.evidence,
      confidence: overrides.company && overrides.position ? 0.99 : 0.94,
    };
  }
  function genericPreview(text, overrides = {}, market = captureMarket || 'cn') {
    const structured = structuredJobPosting();
    const company = (overrides.company || extractCompany(text, market)).trim();
    const position = (overrides.position || structured.position || extractPosition(text)).trim();
    return {
      company,
      position,
      url: location.href,
      evidence: `${document.title} · ${text.slice(0, 240)}`,
    };
  }
  function structuredJobPosting() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || '{}');
        const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (queue.length) {
          const item = queue.shift();
          if (!item || typeof item !== 'object') continue;
          if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
          const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
          if (types.some((type) => String(type).toLowerCase() === 'jobposting'))
            return {
              company: String(item.hiringOrganization?.name || ''),
              position: String(item.title || item.name || ''),
              employmentType: String(item.employmentType || ''),
            };
        }
      } catch {
        /* ignore malformed structured data */
      }
    }
    return { company: '', position: '' };
  }
  function candidateKey(payload, index = 0) {
    return (
      payload.sourceRef ||
      payload.externalApplicationId ||
      `${payload.url}|${payload.eventType}|${payload.company}|${payload.position}|${index}`
    );
  }
  function candidateFingerprint(payload, index = 0) {
    return `${payload.market}|${candidateKey(payload, index)}|${payload.company || ''}|${payload.position || ''}|${payload.eventType || ''}`;
  }
  function candidatePreview(payload, index) {
    return {
      key: candidateKey(payload, index),
      company: payload.company || '',
      position: payload.position || '',
      eventType: payload.eventType,
      title: payload.title,
      recruitmentType: payload.recruitmentType || 'unknown',
      externalApplicationId: payload.externalApplicationId || '',
      evidence: payload.evidence || '',
    };
  }
  function applicationTiming(date) {
    if (!date || !/\d{1,2}:\d{2}/.test(date)) return undefined;
    const value =
      date.replace(' ', 'T') +
      (date.endsWith('Z') || /[+-]\d\d:\d\d$/.test(date) ? '' : ':00+08:00');
    return Number.isFinite(Date.parse(value))
      ? { appliedAt: new Date(value).toISOString(), dateSource: 'website' }
      : undefined;
  }
  function sendCandidate(payload) {
    return sendCandidates([payload]).then((results) => results[0]);
  }
  function sendCandidates(payloads) {
    // 在排队前固定归属，用户后续切换模块不能改变已开始的采集。
    const scopedPayloads = eligibleCandidates(payloads, captureMarket)
      .items.filter(
        (payload) => captureMarket !== 'cn' || /[\u3400-\u9fff]/.test(payload.company || ''),
      )
      .map((payload) => ({ ...payload, market: captureMarket }));
    const operation = sendQueue.then(async () => {
      const indexed = scopedPayloads.map((payload, index) => ({
        payload,
        index,
        fingerprint: candidateFingerprint(payload, index),
      }));
      const fresh = indexed.filter((item) => !sentResults.has(item.fingerprint));
      if (!fresh.length)
        return indexed.map((item) => duplicateResult(sentResults.get(item.fingerprint)));
      const response = await chrome.runtime.sendMessage({
        type: 'candidate-batch',
        payloads: fresh.map((item) => item.payload),
      });
      const freshResults = Array.isArray(response?.results)
        ? response.results
        : fresh.map(() => response || { ok: false });
      const byIndex = new Map();
      fresh.forEach((item, resultIndex) => {
        const result = freshResults[resultIndex] || { ok: false };
        if (result.ok || result.queued) sentResults.set(item.fingerprint, result);
        byIndex.set(item.index, result);
      });
      return indexed.map((item) =>
        sentResults.has(item.fingerprint) && !byIndex.has(item.index)
          ? duplicateResult(sentResults.get(item.fingerprint))
          : byIndex.get(item.index) || { ok: false },
      );
    });
    sendQueue = operation.catch(() => undefined);
    return operation;
  }
  function duplicateResult(result) {
    return { ...result, duplicate: true };
  }
  function recordCurrent(text, submittedItems, legacyOverrides = {}) {
    const detected = candidatesForPreview(text).items;
    const snapshot = previewSnapshots.get(captureMarket) || new Map();
    const byKey = new Map(
      detected.map((candidate, index) => [candidateKey(candidate, index), candidate]),
    );
    // 提交列表是最终清单；删除的项不会重新出现，新增项也不套用另一岗位的状态/编号。
    const overrides = Array.isArray(submittedItems)
      ? submittedItems
      : detected.map((candidate, index) => ({
          key: candidateKey(candidate, index),
          ...(index === 0 ? legacyOverrides : {}),
        }));
    if (!overrides.length) return Promise.resolve({ ok: false, needsInput: true, empty: true });
    const selections = new Map();
    const merged = overrides.map((override) => {
      const original = byKey.get(override?.key) || snapshot.get(override?.key);
      const candidate = original || {
        source: 'website',
        url: location.href,
        eventType: 'application',
        title: '投递成功',
        occurredAt: new Date().toISOString(),
        evidence: '用户手动补充的投递记录',
        confidence: 0.99,
      };
      const rawCompany = String(override?.company ?? candidate.company ?? '').trim();
      const companySource = rawCompany !== candidate.company ? 'manual' : candidate.companySource;
      const company = localizedCompany(rawCompany, captureMarket, Boolean(companySource));
      const position = String(override?.position ?? candidate.position ?? '').trim();
      const updated = {
        ...candidate,
        company,
        companySource,
        position,
        recruitmentType: candidate.recruitmentType || classifyRecruitment(position),
        confidence: override?.company && override?.position ? 0.99 : candidate.confidence,
      };
      if (original)
        selections.set(candidateIdentity(original), { company, position, companySource });
      return updated;
    });
    if (merged.some((item) => !item.company || !item.position))
      return Promise.resolve({ ok: false, needsInput: true, items: merged.map(candidatePreview) });
    if (captureMarket === 'cn' && merged.some((item) => !/[\u3400-\u9fff]/.test(item.company)))
      return Promise.resolve({ ok: false, needsInput: true, needsChineseCompany: true });
    const eligible = eligibleCandidates(merged, captureMarket);
    if (eligible.excluded.length)
      return Promise.resolve({ ok: false, needsInput: true, excluded: true });
    manualSelections.set(captureMarket, selections);
    return sendCandidates(merged);
  }
  function candidateIdentity(candidate) {
    return `${candidate.externalApplicationId || candidate.position}|${candidate.company}`;
  }
  function applyManualSelection(items) {
    const selection = manualSelections.get(captureMarket);
    if (!selection) return items;
    return items
      .filter((item) => selection.has(candidateIdentity(item)))
      .map((item) => ({ ...item, ...selection.get(candidateIdentity(item)) }));
  }
  function eligibleCandidates(candidates, market) {
    const items = [],
      excluded = [];
    for (const candidate of candidates) {
      const type = classifyRecruitment(
        candidate.position,
        candidate.recruitmentType === 'internship'
          ? '实习'
          : candidate.recruitmentType === 'social'
            ? '社会招聘'
            : candidate.recruitmentType === 'spring'
              ? '春招'
              : '',
      );
      const normalized = {
        ...candidate,
        company: localizedCompany(candidate.company, market, Boolean(candidate.companySource)),
        recruitmentType: type === 'unknown' ? candidate.recruitmentType || type : type,
      };
      (market === 'cn' && ['internship', 'social', 'spring'].includes(normalized.recruitmentType)
        ? excluded
        : items
      ).push(normalized);
    }
    return { items, excluded };
  }
  function classifyRecruitment(position = '', metadata = '') {
    if (
      /实习|\bintern(?:s|ship|ships)?\b|\bco[ -]?op\b/i.test(position) ||
      /实习|\bintern(?:s|ship|ships)?\b|\bco[ -]?op\b/i.test(metadata)
    )
      return 'internship';
    const value = `${position} ${metadata}`;
    if (/秋招|秋季|autumn|\bfall\b/i.test(value)) return 'autumn';
    if (/春招|春季|\bspring\b/i.test(value)) return 'spring';
    if (/社会招聘|社招/.test(metadata)) return 'social';
    if (/校招|校园招聘|应届|20\d{2}届/.test(value)) return 'campus';
    return 'unknown';
  }
  function recruitmentMetadata(root) {
    if (!root) return '';
    const selectors =
      '[data-employment-type],[data-recruitment-type],[class*="subTitle"],[class*="subtitle"],[class*="job-type"],[class*="jobType"],[class*="jobProject"],[class*="employment-type"]';
    const semantic = Array.from(root.querySelectorAll(selectors)).map(
      (node) =>
        `${normalizedText(node)} ${node.getAttribute('data-employment-type') || ''} ${node.getAttribute('data-recruitment-type') || ''}`,
    );
    const labels = Array.from(root.querySelectorAll('*'))
      .filter((node) => !node.children.length)
      .map(normalizedText)
      .filter(
        (value) =>
          /^(?:校园招聘|社会招聘|校招|社招|实习(?:生(?:招聘)?)?|正式|全职|(?:日常|暑期|寒假|秋季|春季)实习|internship|intern|co-op)$/i.test(
            value,
          ) ||
          /^(?:招聘类型|招聘项目|项目|用工类型|雇佣类型|职位性质|岗位性质|工作性质|employment type|job type)[：:]/i.test(
            value,
          ),
      );
    return [...semantic, ...labels].join(' ');
  }
  function genericRecruitmentType(position) {
    const structured = structuredJobPosting();
    const labels = Array.from(
      document.querySelectorAll(
        '[data-employment-type],[data-recruitment-type],.job-type,[class*="employment-type"]',
      ),
    )
      .map(
        (node) =>
          `${normalizedText(node)} ${node.getAttribute('data-employment-type') || ''} ${node.getAttribute('data-recruitment-type') || ''}`,
      )
      .join(' ');
    const body = document.body?.innerText || '';
    const explicit =
      body.match(
        /(?:招聘类型|招聘项目|岗位性质|职位性质|工作性质|Employment type|Job type)[：:]\s*([^\n|，。]{1,35})/i,
      )?.[1] || '';
    return classifyRecruitment(
      position,
      `${structured.employmentType || ''} ${labels} ${explicit}`,
    );
  }
  function extractYingjieshengApplication(text) {
    if (location.hostname !== 'q.yingjiesheng.com' || !/投递反馈/.test(text)) return null;
    const row = text.match(
      /([^\s]{2,50})\s+(?:\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?(?:万|千)|薪资面议)\s+(?:已投递|通过筛选|邀笔试|邀面试|不合适)\s+([^\s]{2,40})\s+20\d{2}-\d{2}-\d{2}/,
    );
    if (!row) return null;
    return { position: row[1], company: row[2], evidence: row[0].slice(0, 280) };
  }
  function extractAlibabaApplications(text) {
    if (
      location.hostname !== 'campus-talent.alibaba.com' ||
      !location.pathname.includes('/personal/applications')
    )
      return [];
    const rows = [];
    const pattern =
      /(阿里巴巴控股集团|阿里国际数字商业集团|阿里云)\s+职位\s+所属部门\s+申请日期\s+申请编号\s+当前状态\s+操作\s+(.+?)\s+阿里巴巴20\d{2}届应届生\s+(.+?)\s+(20\d{2}-\d{2}-\d{2})\s+(\d{8,})\s+(新投递|AI评估中|评估中|AI面试中|面试中|Offer|待入职|已终止)/gi;
    for (const match of text.matchAll(pattern)) {
      const [, company, role, department, date, applicationId, status] = match;
      const eventType = /AI评估/i.test(status)
        ? 'ai_assessment'
        : /AI面试/i.test(status)
          ? 'ai_interview'
          : /评估/.test(status)
            ? 'assessment'
            : /面试/.test(status)
              ? 'interview'
              : /offer/i.test(status)
                ? 'offer'
                : /终止/.test(status)
                  ? 'ended'
                  : 'application';
      const title =
        eventType === 'application'
          ? '投递成功'
          : eventType === 'ai_assessment'
            ? '进入 AI 评估'
            : eventType === 'assessment'
              ? '进入评估'
              : eventType === 'ai_interview'
                ? '进入 AI 面试'
                : eventType === 'interview'
                  ? '进入面试'
                  : eventType === 'offer'
                    ? 'Offer 通知'
                    : '流程结束';
      rows.push({
        source: 'website',
        sourceRef: `alibaba:${applicationId}:${eventType}:${status}`,
        company,
        position: `${role}｜${department}`,
        recruitmentType: classifyRecruitment(role, '校园招聘'),
        externalApplicationId: applicationId,
        url: location.href,
        eventType,
        title,
        occurredAt: new Date(`${date}T12:00:00`).toISOString(),
        evidence: `${company} · ${role} · ${department} · 申请编号 ${applicationId} · ${status}`,
        confidence: 0.99,
      });
    }
    return rows;
  }
  function extractBeisenApplications(text, market) {
    if (!/\/personal\/(?:all)?deliveryRecord(?:\/|$)/i.test(location.pathname)) return [];
    const nameElements = Array.from(
      document.querySelectorAll('.delivery-list-job_name,[class*="delivery-list-job_name"]'),
    );
    if (!nameElements.length) return [];
    const footerCompany = text
      .match(/©\s*20\d{2}\s+([^|]{2,35}?)(?=\s+(?:京|沪|粤|苏|浙|Powered|隐私|$))/)?.[1]
      ?.trim();
    const titleCompany = document.title
      .replace(/[-_|]?\s*(?:校园)?招聘(?:官网|网站)?\s*$/i, '')
      .trim();
    const company = localizedCompany(
      footerCompany || titleCompany || extractCompany(text, market),
      market || captureMarket || 'cn',
    );
    const rows = [];
    for (const nameElement of nameElements) {
      const container = nameElement.parentElement?.parentElement;
      const rowText = container?.textContent?.replace(/\s+/g, ' ').trim() || '';
      const rawPosition = nameElement.textContent?.trim() || '';
      const externalApplicationId = applicationIdFromPosition(rawPosition);
      const position = cleanPosition(rawPosition);
      const status =
        rowText
          .match(/当前进度[：:]\s*(.+?)(?=校园招聘|社会招聘|20\d{2}-\d{2}-\d{2}|$)/)?.[1]
          ?.trim() || '已投递';
      const date = rowText.match(/(20\d{2}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)\s*投递/)?.[1] || '';
      if (!company || !position) continue;
      const eventType = /AI.{0,6}(?:面试|面谈)/i.test(status)
        ? 'ai_interview'
        : /AI.{0,6}(?:测评|评估|测试)/i.test(status)
          ? 'ai_assessment'
          : /笔试|在线考试/.test(status)
            ? 'written_test'
            : /测评|评估|测试/.test(status)
              ? 'assessment'
              : /面试|面谈/.test(status)
                ? 'interview'
                : /offer|录用|待入职/i.test(status)
                  ? 'offer'
                  : /不通过|淘汰|拒绝|终止|结束/.test(status)
                    ? 'rejection'
                    : 'application';
      const title =
        eventType === 'application'
          ? /初筛/.test(status)
            ? '简历初筛进行中'
            : '投递成功'
          : eventType === 'ai_assessment'
            ? '进入 AI 测评'
            : eventType === 'assessment'
              ? '进入测评'
              : eventType === 'written_test'
                ? '进入笔试'
                : eventType === 'ai_interview'
                  ? '进入 AI 面试'
                  : eventType === 'interview'
                    ? '进入面试'
                    : eventType === 'offer'
                      ? 'Offer 通知'
                      : '未通过';
      const occurredAt = date
        ? new Date(
            date.includes(' ') ? `${date.replace(' ', 'T')}:00+08:00` : `${date}T12:00:00+08:00`,
          ).toISOString()
        : new Date().toISOString();
      rows.push({
        source: 'website',
        sourceRef: `beisen:${location.hostname}:${externalApplicationId || position}:${date}:${eventType}:${status}`,
        company,
        position,
        recruitmentType: classifyRecruitment(rawPosition, recruitmentMetadata(container)),
        externalApplicationId,
        url: location.href,
        eventType,
        title,
        occurredAt,
        application: applicationTiming(date),
        evidence: `${company} · ${rawPosition} · 当前进度：${status}${date ? ` · ${date} 投递` : ''}`,
        confidence: 0.99,
      });
    }
    return rows;
  }
  function extractMokaApplications(text, options = {}) {
    if (!isMokaApplicationPage()) return [];
    const company = extractCompany(text, options.market);
    const statusNodes = Array.from(document.querySelectorAll('[class*="application-status"]'));
    const rows = [],
      seenCards = new Set();
    for (const statusNode of statusNodes) {
      const status = normalizedText(statusNode);
      let card = null,
        position = '';
      for (
        let cursor = statusNode.parentElement, level = 0;
        cursor && level < 8;
        cursor = cursor.parentElement, level++
      ) {
        const statuses = cursor.querySelectorAll('[class*="application-status"]');
        if (statuses.length > 1) break;
        const candidatePosition = extractMokaCardPosition(cursor, statusNode);
        if (statuses.length === 1 && candidatePosition) {
          card = cursor;
          position = candidatePosition;
          break;
        }
      }
      if (!card || seenCards.has(card)) continue;
      seenCards.add(card);
      const leafTexts = Array.from(card.querySelectorAll('*'))
        .filter((element) => !element.children.length)
        .map((element) => normalizedText(element))
        .filter(Boolean);
      const displayedAt = extractMokaDisplayedAt(leafTexts);
      const externalApplicationId = extractMokaApplicationId(card);
      if ((!company || !position) && !options.includePartial) continue;
      const eventType = eventTypeFromStatus(status);
      const stageKey = mokaStageKey(eventType, status);
      const tenantKey = mokaTenantKey();
      const identity = externalApplicationId || `${position}:${displayedAt}`;
      const occurredAt =
        eventType === 'application' && displayedAt
          ? parseLocalDateTime(displayedAt)
          : new Date().toISOString();
      rows.push({
        source: 'website',
        sourceRef: `moka:${tenantKey}:${identity}:${stageKey}`,
        company,
        position,
        recruitmentType: classifyRecruitment(position, recruitmentMetadata(card)),
        externalApplicationId,
        url: location.href,
        eventType,
        title: titleFromStatus(eventType, status),
        occurredAt,
        application: applicationTiming(displayedAt),
        evidence: `${company} · ${position} · 当前进度：${status}${displayedAt ? ` · 投递时间：${displayedAt}` : ''}`,
        confidence: 0.99,
      });
    }
    return rows;
  }
  function isMokaApplicationPage() {
    return (
      location.hostname.endsWith('.mokahr.com') &&
      /(?:^|#)\/candidateHome\/applications(?:[/?#]|$)/i.test(String(location.hash || ''))
    );
  }
  function isSharedApplicationListRoute() {
    const route = `${location.pathname || ''}${location.hash || ''}`;
    return /(?:^|[/#])(?:candidateHome\/applications|personal\/(?:all)?deliveryRecord|personal\/applications|myDeliver|scrd\/phase\/process|scrd\/delivery\/record)(?:[/?#]|$)/i.test(
      route,
    );
  }
  function extractZhaopinApplications(options = {}) {
    // 此路由只展示已经提交的志愿。未展开的志愿不渲染时间线，仍可确认已投递；
    // 更高阶段只取本卡片已渲染的状态，绝不把其他志愿的进度扩散到整页。
    if (
      location.hostname !== 'xiaoyuan.zhaopin.com' ||
      !/^\/scrd\/phase\/process\/?$/.test(location.pathname)
    )
      return [];
    const root = document.querySelector('.phase-process');
    if (!root) return [];
    const project = String(location.href).match(/[?&]projectId=([^&#]+)/)?.[1] || '';
    const pageCompany = companyFromFields(
      root.querySelectorAll('.company-info')[0] || root,
      options.market,
      true,
    );
    const rows = [];
    for (const card of root.querySelectorAll('[class~="delivery-item"]')) {
      const position = cleanPosition(
        normalizedText(card.querySelectorAll('.delivery-item__wrap-job')[0]),
      );
      const company = companyFromFields(card, options.market, true) || pageCompany;
      if (!isUsefulPositionText(position) || (!company && !options.includePartial)) continue;
      const preference = normalizedText(card.querySelectorAll('.delivery-item__wrap-number')[0]);
      const statuses = Array.from(card.querySelectorAll('.delivery-item__timeline'))
        .flatMap((timeline) => Array.from(timeline.querySelectorAll('*')))
        .filter((node) => !node.children.length)
        .map(normalizedText)
        .filter((value) => progressMarkerRule.test(value));
      const status = statuses.at(-1) || '已投递';
      const eventType = eventTypeFromStatus(status);
      const identity = [project, company, position, preference].map(encodeURIComponent).join(':');
      rows.push({
        source: 'website',
        sourceRef: `zhaopin:${location.hostname}:${identity}:${eventType}:${titleFromStatus(eventType, status)}`,
        company,
        companySource: 'employer-field',
        position,
        recruitmentType: classifyRecruitment(position, recruitmentMetadata(card)),
        url: location.href,
        eventType,
        title: titleFromStatus(eventType, status),
        occurredAt: new Date().toISOString(),
        evidence: `${company} · ${position} · ${preference} · 当前进度：${status}`,
        confidence: 0.99,
      });
    }
    return rows;
  }
  function extractMokaCardPosition(card, statusNode) {
    const semantic = Array.from(card.querySelectorAll('[class*="foundation-heading"],h2,h3,h4,h5'))
      .map((node) => cleanPosition(normalizedText(node)))
      .find(isUsefulPositionText);
    if (semantic) return semantic;
    const leaves = Array.from(card.querySelectorAll('*')).filter(
      (element) => !element.children.length,
    );
    const statusIndex = leaves.indexOf(statusNode);
    const beforeStatus = statusIndex >= 0 ? leaves.slice(0, statusIndex) : leaves;
    return (
      beforeStatus
        .map((node) => cleanPosition(normalizedText(node)))
        .find(
          (value) =>
            isUsefulPositionText(value) && !/^(?:状态|项目)\s*[：:]?$|^修改申请$/.test(value),
        ) || ''
    );
  }
  function extractMokaApplicationId(card) {
    const href =
      Array.from(card.querySelectorAll('*'))
        .map((node) => node.getAttribute?.('href') || '')
        .find((value) => /\/apply\/edit\//i.test(value)) || '';
    return href.match(/\/apply\/edit\/([^/?#]+)/i)?.[1] || '';
  }
  function extractMokaDisplayedAt(leafTexts) {
    const full = leafTexts
      .map((value) => value.match(/^(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})$/))
      .find(Boolean);
    if (full)
      return `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')} ${full[4].padStart(2, '0')}:${full[5]}`;
    const short = leafTexts
      .map((value) => value.match(/^(\d{1,2}):(\d{2})$/))
      .find((match) => match && Number(match[1]) < 24 && Number(match[2]) < 60);
    if (!short) return '';
    const now = new Date();
    const local = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number(short[1]),
      Number(short[2]),
      0,
      0,
    );
    if (local.getTime() > now.getTime() + 5 * 60 * 1000) local.setDate(local.getDate() - 1);
    return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')} ${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  }
  function parseLocalDateTime(value) {
    const match = String(value || '').match(/^(20\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
    if (!match) return new Date().toISOString();
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      0,
      0,
    ).toISOString();
  }
  function mokaTenantKey() {
    const match = String(location.pathname || '').match(
      /\/(?:campus-recruitment|social-recruitment)\/([^/?#]+)\/([^/?#]+)/i,
    );
    return match ? `${match[1]}:${match[2]}` : location.hostname;
  }
  function mokaStageKey(eventType, status) {
    if (eventType === 'application') return /筛选|初筛/.test(status) ? 'screening' : 'submitted';
    return (
      {
        rejection: 'rejected',
        ended: 'ended',
        offer: 'offer',
        ai_interview: 'ai-interview',
        ai_assessment: 'ai-assessment',
        written_test: 'written-test',
        assessment: 'assessment',
        interview: 'interview',
      }[eventType] || eventType
    );
  }
  function extractApplicationCards(options = {}) {
    const allElements = Array.from(document.querySelectorAll('*'));
    const markers = allElements.filter(
      (element) => !element.children.length && progressMarkerRule.test(normalizedText(element)),
    );
    const explicitCards = new Set(document.querySelectorAll(applicationCardSelectors));
    const cardContexts = new Map();
    const registerCard = (detail, markerText = '', contextualPosition = '') => {
      // Status/date blocks may contain only metadata. Resolve them to the same
      // complete application card so its title, status and ID stay together.
      for (
        let cursor = detail, level = 0;
        cursor && level < 7;
        level++, cursor = cursor.parentElement
      ) {
        const dates = countDateLeaves(cursor);
        if (dates > 1) break;
        if (
          explicitCards.has(cursor) &&
          dates === 1 &&
          isApplicationRecord(compactText(cursor), extractCardPosition(cursor))
        ) {
          detail = cursor;
          break;
        }
      }
      contextualPosition = extractCardPosition(detail) || contextualPosition;
      const current = cardContexts.get(detail);
      if (!current || (markerText && !current.markerText))
        cardContexts.set(detail, { markerText, contextualPosition });
    };
    for (const marker of markers) {
      let cursor = marker.parentElement,
        detail = null,
        contextualPosition = '';
      for (let level = 0; cursor && level < 6; level++, cursor = cursor.parentElement) {
        const value = compactText(cursor);
        const hasApplicationDate = Boolean(extractApplicationDate(value));
        const hasCompanyField = /(?:所属公司|公司名称)[：:]/.test(value);
        const positionInCard = extractCardPosition(cursor);
        if (hasApplicationDate && (hasCompanyField || positionInCard) && value.length < 1600) {
          detail = cursor;
          contextualPosition = positionInCard;
          break;
        }
      }
      if (!detail) continue;
      registerCard(detail, normalizedText(marker), contextualPosition);
    }
    for (const detail of explicitCards) {
      if (isRecommendationNode(detail)) continue;
      const value = compactText(detail);
      const position = extractCardPosition(detail);
      const statuses = Array.from(detail.querySelectorAll('*'))
        .filter((node) => !node.children.length)
        .map(normalizedText)
        .filter((value) => progressMarkerRule.test(value));
      const titles = new Set(
        Array.from(detail.querySelectorAll(cardPositionSelectors))
          .map(normalizedText)
          .map(cleanPosition)
          .filter(isUsefulPositionText),
      );
      // 日期并非确认申请的必要条件；明确卡片、唯一岗位和卡内进度也可以确认。
      // 无日期时不从全页状态回退，不用识别时刻填充真实投递日期。
      if (
        (countDateLeaves(detail) === 1 && isApplicationRecord(value, position)) ||
        (value.length < 1600 &&
          countDateLeaves(detail) === 0 &&
          titles.size === 1 &&
          statuses.length === 1)
      )
        registerCard(detail, statuses.at(-1) || '', position);
    }
    const dateAnchors = allElements.filter(
      (element) =>
        !element.children.length && Boolean(extractApplicationDate(normalizedText(element))),
    );
    for (const anchor of dateAnchors) {
      for (
        let cursor = anchor.parentElement, level = 0;
        cursor && level < 7;
        cursor = cursor.parentElement, level++
      ) {
        if (countDateLeaves(cursor) > 1) break;
        const value = compactText(cursor);
        const position = extractCardPosition(cursor);
        if (isApplicationRecord(value, position)) {
          registerCard(cursor, '', position);
          break;
        }
      }
    }
    const rows = [],
      seen = new Set();
    for (const [detail, context] of cardContexts) {
      const leafTexts = Array.from(detail.querySelectorAll('*'))
        .filter((element) => !element.children.length)
        .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() || '')
        .filter(Boolean);
      const compact = compactText(detail);
      const companyText =
        leafTexts.find((value) => /^(?:所属公司|公司名称)[：:]/.test(value)) || '';
      const fieldCompany = companyFromFields(detail, options.market, true);
      const company =
        companyText.match(/^(?:所属公司|公司名称)[：:]\s*(.+)$/)?.[1]?.trim() ||
        compact
          .match(
            /(?:所属公司|公司名称)[：:]([^：:]{2,60}?)(?=所属部门|部门名称|简历名称|投递时间|申请时间|$)/,
          )?.[1]
          ?.trim() ||
        fieldCompany ||
        extractCompany('', options.market, { pageOnly: true });
      const semanticDate =
        Array.from(
          detail.querySelectorAll(
            '.date,[class*="application-date"],[class*="applicationDate"],[class*="delivery-date"],[class*="deliveryDate"]',
          ),
        )
          .map(normalizedText)
          .find(extractApplicationDate) || '';
      const dateText =
        leafTexts.find((value) => /^(?:投递|申请)时间[：:]/.test(value)) ||
        leafTexts.find((value) => extractApplicationDate(value) && /(?:投递|申请)/.test(value)) ||
        semanticDate ||
        leafTexts.find(extractApplicationDate) ||
        '';
      const date = extractApplicationDate(dateText) || extractApplicationDate(compact);
      const markerText = context.markerText || '';
      const markerIndex = leafTexts.findIndex((value) => value === markerText);
      const position = cleanPosition(
        context.contextualPosition ||
          extractCardPosition(detail) ||
          leafTexts
            .slice(Math.max(markerIndex + 1, 0))
            .map(cleanPosition)
            .find(isUsefulPositionText) ||
          '',
      );
      const detailedStatuses = leafTexts.filter((value) => detailedProgressRule.test(value));
      const status = detailedStatuses[detailedStatuses.length - 1] || markerText || '已投递';
      // 页面根容器的 id（如 midas-view-content）由所有岗位共用，不能作为申请编号。
      const explicitId =
        detail.getAttribute('data-application-id') || detail.getAttribute('data-delivery-id') || '';
      const ownId = detail.id || '';
      const externalApplicationId =
        explicitId ||
        (/^(?:[a-f0-9]{16,64}|\d{6,30}|[a-z]{1,5}\d{3,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(
          ownId,
        )
          ? ownId
          : '') ||
        leafTexts.map(applicationIdFromPosition).find(Boolean) ||
        '';
      if ((!company || !position) && !options.includePartial) continue;
      const eventType = eventTypeFromStatus(status);
      const key = `${externalApplicationId}|${company}|${position}|${date}|${eventType}|${status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const occurredAt = parseChinaDate(date);
      rows.push({
        source: 'website',
        sourceRef: `application-card:${location.hostname}:${externalApplicationId || position}:${date}:${eventType}:${status}`,
        company,
        companySource: companyText || fieldCompany ? 'employer-field' : undefined,
        position,
        recruitmentType: classifyRecruitment(position, recruitmentMetadata(detail)),
        externalApplicationId,
        url: location.href,
        eventType,
        title: titleFromStatus(eventType, status),
        occurredAt,
        application: applicationTiming(date),
        evidence: `${company} · ${position} · 当前进度：${status}${date ? ` · ${date} 投递` : ''}`,
        confidence: 0.99,
      });
    }
    return rows;
  }
  function normalizedText(element) {
    return element?.textContent?.replace(/\s+/g, ' ').trim() || '';
  }
  function compactText(element) {
    return element?.textContent?.replace(/\s+/g, '').trim() || '';
  }
  function extractApplicationDate(value) {
    const match = String(value || '').match(
      /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s*(\d{1,2}):(\d{2}))?/,
    );
    if (!match) return '';
    const [, year, month, day, hour, minute] = match;
    const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    return hour ? `${date} ${hour.padStart(2, '0')}:${minute}` : date;
  }
  function countDateLeaves(root) {
    return Array.from(root.querySelectorAll('*')).filter(
      (element) => !element.children.length && extractApplicationDate(normalizedText(element)),
    ).length;
  }
  function isApplicationRecord(value, position) {
    return (
      value.length < 1600 &&
      Boolean(position) &&
      Boolean(extractApplicationDate(value)) &&
      applicationEvidenceRule.test(value)
    );
  }
  function extractCardPosition(root) {
    // Explicit job-title fields outrank generic headings and adjacent metadata.
    for (const selectors of [cardPositionSelectors, 'h2,h3,h4,h5']) {
      const selected = Array.from(root.querySelectorAll(selectors))
        .map((node) => cleanPosition(normalizedText(node)))
        .find(isUsefulPositionText);
      if (selected) return selected;
    }
    const preferencePosition =
      Array.from(root.querySelectorAll('*'))
        .filter((element) => !element.children.length)
        .map((element) => normalizedText(element))
        .map(
          (value) =>
            value.match(/^(.{2,100}?)\s*第\s*\d+\s*志愿(?:\s*官网投递)?$/)?.[1]?.trim() || '',
        )
        .find(isUsefulPositionText) || '';
    if (preferencePosition) return preferencePosition;
    const value = compactText(root);
    if (!extractApplicationDate(value) || !applicationEvidenceRule.test(value)) return '';
    const leaves = Array.from(root.querySelectorAll('*'))
      .filter((element) => !element.children.length)
      .map((element) => normalizedText(element))
      .filter(Boolean);
    const dateIndex = leaves.findIndex(extractApplicationDate);
    const candidates =
      dateIndex > 0 ? [...leaves.slice(0, dateIndex), ...leaves.slice(dateIndex + 1)] : leaves;
    return candidates.map(cleanPosition).find(isUsefulPositionText) || '';
  }
  function cleanPosition(value) {
    return String(value || '')
      .replace(/\s*第\s*\d+\s*志愿(?:\s*官网投递)?\s*$/, '')
      .replace(/\s*志愿已过期\s*$/, '')
      .replace(/【20\d{2}年?校园招聘】$/, '')
      .replace(/\(([A-Za-z]+\d{3,})\)\s*$/, '')
      .trim();
  }
  function applicationIdFromPosition(value) {
    return String(value || '').match(/\(([A-Za-z]+\d{3,})\)\s*$/)?.[1] || '';
  }
  function isUsefulPositionText(value) {
    return (
      value.length >= 2 &&
      value.length <= 100 &&
      !progressMarkerRule.test(value) &&
      !/^(?:校园招聘|社会招聘|实习生招聘|官网(?:主)?投|投递简历|简历投递|立即投递|导出简历|撤回投递|更新简历|投递记录|投递进程|投递结果|进程|结果|完成投递|个人中心|热门职位|推荐职位|相似职位推荐|职位列表|岗位列表|岗位信息|职位信息|基本信息|岗位详情|职位详情|申请信息|投递信息|编辑|查看(?:\/打印)?|没有更多了[~～]?)$/.test(
        value,
      ) &&
      !/^(?:20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|20\d{2}校园招聘|所属公司|公司名称|所属部门|部门名称|简历名称|投递时间|申请时间|工作地点|职位类别|岗位类别)/.test(
        value,
      ) &&
      !/^(?:第\s*\d+\s*志愿|志愿(?:信息|序号|顺序)?(?:[：:]|$)|(?:(?:招聘|投递|申请)(?:类型|项目|批次|编号|记录)|简历(?:版本|信息))(?:[：:]|$))/.test(
        value,
      ) &&
      !/^20\d{2}(?:届|年)?(?:校园招聘|校招|春招|秋招|春季招聘|秋季招聘)$/.test(value) &&
      !/^(?:北京|上海|广州|深圳|杭州|成都|武汉|西安)(?:市)?$/.test(value) &&
      !/^(?:北京|上海|广州|深圳|杭州|成都|武汉|西安)\s*[|｜]/.test(value)
    );
  }
  function eventTypeFromStatus(status) {
    if (/不通过|不匹配|淘汰|拒绝|不合适/.test(status)) return 'rejection';
    if (/终止|结束|关闭|撤回/.test(status)) return 'ended';
    if (/AI.{0,8}(?:面试|面谈)/i.test(status)) return 'ai_interview';
    if (/AI.{0,8}(?:测评|评估|测试)/i.test(status)) return 'ai_assessment';
    if (/笔试|在线考试/.test(status)) return 'written_test';
    if (/测评|评估|测试/.test(status)) return 'assessment';
    if (/面试|面谈/.test(status)) return 'interview';
    if (/offer|录用|待入职|已入职/i.test(status)) return 'offer';
    return 'application';
  }
  function titleFromStatus(type, status) {
    return type === 'application'
      ? /初筛|待处理简历|筛选/.test(status)
        ? '简历筛选中'
        : '投递成功'
      : {
          ai_assessment: '进入 AI 测评',
          assessment: '进入测评',
          written_test: '进入笔试',
          ai_interview: '进入 AI 面试',
          interview: '进入面试',
          offer: 'Offer 通知',
          rejection: '未通过',
          ended: '流程结束',
        }[type] || '进度更新';
  }
  function parseChinaDate(value) {
    if (!value) return new Date().toISOString();
    const normalized = value.includes(' ')
      ? `${value.replace(' ', 'T')}:00+08:00`
      : value.length === 16
        ? `${value.slice(0, 10)}T${value.slice(10)}:00+08:00`
        : `${value}T12:00:00+08:00`;
    return new Date(normalized).toISOString();
  }
  function extractCompany(text, market = captureMarket || 'cn', options = {}) {
    const structured = structuredJobPosting();
    const selected = companyFromFields(document, market);
    const brand = firstUsefulText(
      '.topbar-site-title,[class*="site-title"],[class*="siteTitle"],[class*="brand-name"],[class*="brandName"]',
      60,
      /应聘记录|申请记录|投递记录|个人中心/,
    );
    const tenant = structuredWebsiteCompany();
    const siteName = document
      .querySelector('meta[property="og:site_name"]')
      ?.getAttribute('content')
      ?.trim();
    const description =
      document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
    const descriptionCompany = description
      .match(/(?:查看你在|查看您在|加入)([^，。、]{2,60}?)(?:的投递|的申请|招聘|$)/)?.[1]
      ?.trim();
    const titleBrand = companyFromTitle(document.title);
    const footer = text
      .match(/©\s*20\d{2}\s+([^|]{2,35}?)(?=\s+(?:京|沪|粤|苏|浙|Powered|隐私|$))/)?.[1]
      ?.trim();
    const labelled = text
      .match(
        /(?:^|[\s;；|])(?:所属公司|公司名称|企业名称|公司|企业)[：:]\s*([^，。；]{2,60}?)(?=\s*(?:所属部门|部门名称|简历名称|岗位|职位|投递时间|申请时间|$))/,
      )?.[1]
      ?.trim();
    const englishLabel = text
      .match(
        /\b(?:company|employer)(?: name)?\s*:\s*(.{2,60}?)(?=\s+(?:job|position|role|location|application|status)\b|[\n|]|$)/i,
      )?.[1]
      ?.trim();
    const englishReceipt = text
      .match(/\b(?:thank you|thanks) for applying to\s+(.{2,60}?)(?=\s+for (?:the )?|[.!]|$)/i)?.[1]
      ?.trim();
    const candidates = [
      options.pageOnly ? '' : structured.company,
      selected,
      labelled,
      englishLabel,
      englishReceipt,
      tenant,
      brand,
      titleBrand,
      descriptionCompany,
      siteName,
      footer,
    ]
      .map(cleanCompany)
      .filter(isUsefulCompany);
    if (market === 'cn')
      return (
        candidates.find((value) => /[\u3400-\u9fff]/.test(value)) ||
        localizedCompany(candidates[0] || '', market)
      );
    return candidates[0] || '';
  }
  function localizedCompany(value, market, explicitEmployer = false) {
    const name = cleanCompany(value);
    if (!isUsefulCompany(name, explicitEmployer)) return '';
    if (market !== 'cn' || /[\u3400-\u9fff]/.test(name)) return name;
    // 精确别名与官方域名提供确定映射；未知英文名留给用户填写，避免猜译。
    if (
      /^(?:pape(?:r)?\s*games)(?:\s+(?:co\.?|ltd\.?|inc\.?|limited))*$/i.test(name) ||
      /(?:^|\.)papegames\.(?:com|cn|net)$/i.test(location.hostname)
    )
      return '叠纸游戏';
    return name;
  }
  function companyFromFields(root, market = captureMarket || 'cn', explicitEmployer = false) {
    const cards =
      root === document ? new Set(document.querySelectorAll(applicationCardSelectors)) : null;
    const names = Array.from(root.querySelectorAll(companySelectors))
      .filter((node) => {
        if (isRecommendationNode(node)) return false;
        if (cards)
          for (let cursor = node; cursor; cursor = cursor.parentElement)
            if (cards.has(cursor)) return false;
        return true;
      })
      .map((node) =>
        cleanCompany(
          node.getAttribute('data-company-name') ||
            node.getAttribute('data-company') ||
            node.getAttribute('data-employer') ||
            normalizedText(node),
        ),
      )
      .filter((name) => isUsefulCompany(name, explicitEmployer));
    const unique = [...new Set(names)];
    // 没有卡片范围时，多个不同雇主不能靠 DOM 顺序选第一家。
    if (root === document && unique.length > 1) return '';
    return market === 'cn'
      ? unique.find((name) => /[\u3400-\u9fff]/.test(name)) || unique[0] || ''
      : unique[0] || '';
  }
  function isRecommendationNode(node) {
    for (let cursor = node; cursor; cursor = cursor.parentElement) {
      if (
        /recommend|similar[-_ ]?(?:job|position)|related[-_ ]?(?:job|position)/i.test(
          String(cursor.className || '') + ' ' + String(cursor.id || ''),
        )
      )
        return true;
    }
    return false;
  }
  // 与服务端 candidate-fields 的平台名称校验保持一致；精确匹配，不误伤“智联科技”等企业。
  function isPlatformCompany(value) {
    const name = String(value || '')
      .trim()
      .replace(/[\s._·-]/g, '')
      .replace(/(?:官网|网站|平台|网)$/, '')
      .replace(/(?:(?:校园|社会)?招聘|校招)$/, '')
      .toLowerCase();
    return /^(?:智联(?:校园)?|zhaopin(?:com)?|前程无忧|51job(?:com)?|应届生(?:求职)?|yingjiesheng(?:com)?|boss直聘|boss|zhipin(?:com)?|猎聘|liepin(?:com)?|拉勾|lagou(?:com)?|实习僧|牛客|nowcoder(?:com)?|workday|myworkdayjobs|greenhouse|lever|ashby|moka|mokahr|北森|beisen|ibeisen|italent|hotjob|飞书|feishu|smartrecruiters|icims|taleo|successfactors)$/.test(
      name,
    );
  }
  function structuredWebsiteCompany() {
    const node = document.querySelector('#js-websiteInfo');
    if (!node) return '';
    try {
      const data = JSON.parse(node.textContent || node.getAttribute('content') || '{}');
      return String(
        data?.tenant_info?.tenant_name || data?.tenantInfo?.tenantName || data?.tenant?.name || '',
      ).trim();
    } catch {
      return '';
    }
  }
  function companyFromTitle(value) {
    const parts = String(value || '')
      .split(/\s+[—–-]\s+|\s*[|｜_]\s*/)
      .filter(Boolean);
    if (parts.length > 1) {
      const company = [...parts]
        .reverse()
        .map((part) => cleanCompany(part.replace(/^加入\s*/, '')))
        .find(isUsefulCompany);
      return company || '';
    }
    return cleanCompany(
      String(value || '')
        .replace(/[-_|｜]?\s*(?:(?:校园|社会)?招聘|校招)(?:官网|网站|平台)?\s*$/i, '')
        .replace(/[-_|｜]\s*$/, '')
        .trim(),
    );
  }
  function isUsefulCompany(value, explicitEmployer = false) {
    return (
      value.length >= 2 &&
      value.length <= 60 &&
      (explicitEmployer === true || !isPlatformCompany(value)) &&
      !/^(?:应聘记录|我的应聘|申请记录|我的申请|投递记录|我的投递|投递进程|投递结果|申请进程|申请结果|我的校园|职位详情|岗位详情|职位列表|岗位列表|个人中心|校园招聘|社会招聘|校招|招聘|招聘官网|首页)$/i.test(
        value,
      ) &&
      !/20\d{2}届?(?:春|秋)?招/.test(value) &&
      !/^(?:careers?|jobs?|apply|apply now|application(?: submitted| received| confirmation)?|thank you|thanks)(?:[!.])?$/i.test(
        value,
      ) &&
      !/^(?:thank you|thanks) for applying|^your application\b/i.test(value)
    );
  }
  function cleanCompany(value) {
    return String(value || '')
      .replace(/(?:(?:校园|社会)?招聘|校招)(?:官网|网站|平台)?$/, '')
      .replace(/^[\s|｜_—–-]+|[\s|｜_—–-]+$/g, '')
      .trim();
  }
  function extractPosition(text) {
    const structured = structuredJobPosting();
    const selectors =
      '[data-position],[data-position-name],[data-position-title],[data-job-name],[data-job-title],[data-automation-id="jobPostingHeader"],[data-testid="job-title"],.job-name,.jobName,.position-name,.position-title,.delivery-list-job_name,[class*="job-name"],[class*="job_name"],[class*="jobName"],[class*="job-title"],[class*="jobTitle"],[class*="position-name"],[class*="position_name"],[class*="positionName"],[class*="position-title"],[class*="positionTitle"]';
    const selected = firstUsefulText(
      selectors,
      100,
      /已投递过|最近投递|职位数|岗位数|所属公司|所属部门|简历名称/,
    );
    const labelled = text
      .match(
        /(?:职位|岗位)(?:名称)?[：:\s]*([^，。；]{2,100}?)(?=\s*(?:所属公司|所属部门|部门名称|简历名称|投递时间|申请时间|当前进度|工作地点|职位类别|岗位类别|招聘类型|职位描述|岗位职责|工作职责|任职要求|立即投递|$))/,
      )?.[1]
      ?.trim();
    const title = document.title.match(/(?:申请|投递)[-_ ]?([^|_-]{2,55})/)?.[1]?.trim();
    const heading = Array.from(document.querySelectorAll('h1'))
      .filter((node) => !isRecommendationNode(node))
      .map((node) => node.textContent?.trim() || '')
      .find(
        (value) =>
          value.length >= 2 &&
          value.length <= 70 &&
          !/招聘官网|校园招聘|投递记录|个人中心/.test(value),
      );
    const englishLabel = text
      .match(
        /\b(?:job title|position|role)\s*:\s*(.{2,100}?)(?=\s+(?:company|employer|location|application|status|date applied)\b|[\n|]|$)/i,
      )?.[1]
      ?.trim();
    const englishReceipt = text
      .match(
        /\b(?:application for|applying for) (?:the )?(.{2,100}?)(?=\s+(?:position|role)\b|\s+at\s+|[.!]|$)/i,
      )?.[1]
      ?.trim();
    return (
      [structured.position, selected, labelled, englishLabel, title, heading, englishReceipt]
        .map(cleanPosition)
        .find((value) => isUsefulPositionText(value) && !isGenericEnglishHeading(value)) || ''
    );
  }
  function isGenericEnglishHeading(value) {
    return (
      /^(?:(?:your )?applications?|my applications|application (?:submitted|received|confirmation)|thank you(?: for (?:applying|your application))?|thanks(?: for applying)?|careers?|jobs?|apply(?: now)?|welcome)(?:[!.])?$/i.test(
        value,
      ) || /^(?:your application\b|thank you for applying\b|thanks for applying\b)/i.test(value)
    );
  }
  function firstUsefulText(selectors, maxLength, excluded) {
    return (
      Array.from(document.querySelectorAll(selectors))
        .filter((node) => !isRecommendationNode(node))
        .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() || '')
        .find((value) => value.length >= 2 && value.length <= maxLength && !excluded.test(value)) ||
      ''
    );
  }
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'capture-editor') return;
    editorPorts.add(port);
    port.onDisconnect.addListener(() => {
      editorPorts.delete(port);
      if (editorPorts.size) return;
      // 侧栏可能只切换了预览模块。关闭后重新读取启用状态，不能继续用旧模块采集。
      captureMarket = null;
      contextRefresh = chrome.runtime
        .sendMessage({ type: 'capture-context', url: location.href })
        .then((context) => {
          if (context?.enabled && ['cn', 'us'].includes(context.market))
            captureMarket = context.market;
        })
        .catch(() => undefined);
    });
  });
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(inspect, 900);
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  document.addEventListener('submit', () => setTimeout(inspect, 1200), true);
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'inspect-now') {
      Promise.resolve(inspect({ market: message.market })).then((result) =>
        sendResponse(result || { ok: true, noChange: true }),
      );
      return true;
    }
    if (message.type === 'preview-current') {
      const text = document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 16000) || '';
      const market = message.market === 'us' ? 'us' : 'cn';
      const preview = candidatesForPreview(text, market);
      previewSnapshots.set(
        market,
        new Map(
          preview.items.map((candidate, index) => [candidateKey(candidate, index), candidate]),
        ),
      );
      const items = preview.items.map(candidatePreview);
      sendResponse({
        ok: true,
        items,
        excluded: preview.excluded.map(candidatePreview),
        company: items[0]?.company || '',
        position: items[0]?.position || '',
      });
      return;
    }
    if (message.type === 'record-current') {
      const text = document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 16000) || '';
      void contextReady
        .then(() => {
          if (['cn', 'us'].includes(message.market)) captureMarket = message.market;
          if (!captureMarket) return { ok: false, needsModule: true };
          return recordCurrent(text, message.items, message.overrides || {});
        })
        .then((result) => sendResponse(result || { ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
  });
  setTimeout(inspect, 800);
})();
