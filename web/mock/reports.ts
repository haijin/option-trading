import type { ScreenView, SkillId } from '../../src/server/api-types';
import { qualityScreen } from './kpi';
import type { Profile } from './model';
import { marketCurrency } from './symbols';
import { fmt2, round } from './util';
import { intrinsicFor } from './value';

const cur = (p: Profile): string => (marketCurrency(p.market) === 'HKD' ? 'HK$' : 'US$');
const money = (p: Profile, x: number): string => `${cur(p)}${fmt2(x)}`;

function header(p: Profile, title: string, date: string): string[] {
  return [
    `# ${p.zhName}（${p.symbol}）${title}`,
    '',
    '> **说明**：本报告由演示用的模拟执行器（fake executor）生成，数据为示例数据，仅供决策参考，不构成投资建议。本应用不会下单。',
    '',
    `**标的**：${p.zhName} · ${p.market}:${p.symbol} · 行业 ${p.sector}　**日期**：${date}　**最新收盘价**：${money(p, p.spot)}`,
    '',
  ];
}

function footer(p: Profile, date: string): string[] {
  const source =
    p.market === 'HK'
      ? '[港交所披露易 HKEXnews](https://www.hkexnews.hk/)'
      : '[SEC EDGAR 公开披露](https://www.sec.gov/edgar/search/)';
  return [
    '## 后续行动',
    '',
    '1. 在 Today 页面核对这只股票今天建议的卖出合约。',
    `2. 问自己：被行权后，我愿意以净成本 ${p.contract ? money(p, p.contract.strike - p.contract.prem) : '内在价值以下'} 持有吗？`,
    '3. 下一次财报日前后重新运行本分析。',
    '',
    '## 数据核对',
    '',
    `主要数字抽样复核（${date}），与第二来源的差异超过 1% 的项目已标注：`,
    '',
    '```text',
    `check roe5      source_a=${p.fund.roe5.toFixed(1)}  source_b=${(p.fund.roe5 * 1.004).toFixed(1)}  diff=0.4%  ok`,
    `check fcf/share source_a=${p.fund.fcfps.toFixed(2)}  source_b=${(p.fund.fcfps * 0.993).toFixed(2)}  diff=0.7%  ok`,
    `check eps       source_a=${p.fund.eps.toFixed(2)}  source_b=${p.fund.eps.toFixed(2)}  diff=0.0%  ok`,
    '```',
    '',
    `原始披露文件见 ${source}。`,
    '',
  ];
}

function valuationTable(p: Profile): string[] {
  const iv = intrinsicFor(p);
  const lines = ['| 方法 | 每股价值 | 相对现价 | 说明 |', '| --- | ---: | ---: | --- |'];
  for (const m of iv.methods) {
    const rel = Math.round((m.value / p.spot - 1) * 100);
    lines.push(`| ${m.label} | ${money(p, m.value)} | ${rel >= 0 ? '+' : ''}${rel}% | ${m.note} |`);
  }
  lines.push(
    '',
    `**内在价值（基准）**：${money(p, iv.base ?? p.spot)}，区间 ${money(p, iv.low ?? p.spot)} 至 ${money(p, iv.high ?? p.spot)}；现价是内在价值的 **${Math.round((iv.priceRatio ?? 1) * 100)}%**（${iv.stars ?? 3} 星）。`,
    '',
  );
  return lines;
}

function scenarioTable(p: Profile): string[] {
  const iv = intrinsicFor(p);
  const names = { Bull: '乐观', Base: '基准', Bear: '悲观' };
  return [
    '| 情景 | 年增速 | 目标市盈率 | 三年后 EPS | 三年后股价 | 今日价值 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...iv.scenarios.map(
      (s) =>
        `| ${names[s.name]} | ${s.growthPct}% | ${s.targetPe}x | ${fmt2(s.eps3y)} | ${fmt2(s.price3y)} | **${money(p, s.presentValue)}** |`,
    ),
    '',
  ];
}

const researchBody = (p: Profile): string[] => {
  const iv = intrinsicFor(p);
  const base = iv.base ?? p.spot;
  return [
    '## 一、信息丰富度评级',
    '',
    `- 评级：**${p.fund.info}**（${p.fund.info === 'A' ? '覆盖充分，需警惕与市场一致预期同质化' : '覆盖一般，所有估计都要标注置信度'}）`,
    '- 免费数据只有约 4 年年报，长周期指标（10 年 ROE）需要付费数据源补足',
    '',
    '## 二、商业本质（段永平视角）',
    '',
    `1. ${p.zhName}属于${p.sector}行业，5 年平均 ROE 约 **${p.fund.roe5}%**，净利率约 **${p.fund.nm}%**。`,
    '2. 好生意的标志是：不需要不断追加资本也能增长。',
    `3. 自由现金流 / 股 ${fmt2(p.fund.fcfps)}，资本开支占收入约 ${p.fund.capex}%。`,
    '',
    '## 三、护城河（巴菲特视角）',
    '',
    '- 品牌与转换成本：来自用户习惯和生态黏性',
    '- 规模优势：单位成本随体量下降',
    '- **风险点**：监管变化可能削弱定价权',
    '',
    '## 四、逆向思考（芒格视角）：它会怎么失败？',
    '',
    '| 失败路径 | 概率 | 影响 | 先行信号 |',
    '| --- | :---: | :---: | --- |',
    '| 核心业务增速连续两年低于 GDP | 中 | 高 | 营收同比转负 |',
    '| 资本配置失误（高价并购） | 低 | 高 | 商誉占净资产超过 30% |',
    '| 监管或政策冲击 | 中 | 中 | 新规草案、罚款公告 |',
    '',
    '## 五、管理层与长期趋势',
    '',
    '1. 管理层持股与回购记录良好，近五年摊薄 ' + (p.fund.dil < 0 ? '为负（净回购）' : '较小') + '。',
    '2. 行业二十年格局：龙头集中度上升，估值中枢随利率下移。',
    '',
    '## 六、估值与安全边际',
    '',
    ...valuationTable(p),
    ...scenarioTable(p),
    '反向 DCF 的核对脚本（示意）：',
    '',
    '```python',
    'from valuation import implied_growth',
    `g = implied_growth(price=${p.spot}, fcf0=${p.fund.fcfps}, rate=0.08)`,
    `print(f"{g:.1%}")  # 现价隐含的未来五年自由现金流增速`,
    '```',
    '',
    '## 七、决策表',
    '',
    `- **无仓位**：卖出 put 的行权价不高于 ${money(p, base)}（内在价值 100%），优先 ${money(p, base * 0.85)} 以下`,
    `- **被行权后**：持有股票，高于 ${money(p, base)} 可考虑备兑认购`,
    `- **加仓信号**：价格低于 ${money(p, base * 0.7)} 且论文未变`,
    `- **卖出信号**：价格高于 ${money(p, base * 1.2)}（内在价值 120%）或触发红线`,
    '',
  ];
};

const checklistBody = (p: Profile): string[] => {
  const iv = intrinsicFor(p);
  const f = p.fund;
  return [
    '## 六道关',
    '',
    '| 关口 | 星级 | 依据 |',
    '| --- | :---: | --- |',
    `| 1. 能力圈 | ${'★'.repeat(f.comp)}${'☆'.repeat(5 - f.comp)} | 个人判断，需你自己确认 |`,
    `| 2. 好生意 | ${f.roe5 > 15 ? '★★★★' : '★★★'}☆ | ROE ${f.roe5}%，自由现金流为正 |`,
    '| 3. 护城河 | ★★★☆☆ | 由 AI 依据证据判断 |',
    `| 4. 管理层 | ${'★'.repeat(f.mg)}${'☆'.repeat(5 - f.mg)} | 资本配置与诚信记录 |`,
    `| 5. 价格 | ${'★'.repeat(iv.stars ?? 3)}${'☆'.repeat(5 - (iv.stars ?? 3))} | 现价是内在价值的 ${Math.round((iv.priceRatio ?? 1) * 100)}% |`,
    '| 6. 纪律 | ★★★★☆ | 无 FOMO，能用 200 字写出理由 |',
    '',
    '## 镜子测试',
    '',
    `> 我愿意在 ${p.contract ? money(p, p.contract.strike) : '内在价值以下'} 被行权持有${p.zhName}，因为：业务我能用一句话讲清楚；护城河可持续；管理层得分 ${f.mg}/5；净成本低于内在价值；下行空间有限。`,
    '',
    '## 八项一票否决',
    '',
    '- [x] 能说清楚它如何赚钱',
    `- [${f.fcfps > 0 ? 'x' : ' '}] 自由现金流连续三年不为负`,
    '- [x] 管理层无诚信污点',
    '- [x] 护城河未被不可逆侵蚀',
    '',
  ];
};

const earningsBody = (p: Profile): string[] => [
  '## 数据可得性',
  '',
  `- 一手披露：${p.market === 'HK' ? '港交所披露易（中期与年度报告）' : 'SEC 10-K / 10-Q'}`,
  '- 关键数字均与第二来源交叉验证',
  '',
  '## 关键数字',
  '',
  '| 指标 | 本期 | 五年均值 | 变化 |',
  '| --- | ---: | ---: | ---: |',
  `| 毛利率 | ${p.fund.gm === null ? '不适用' : `${p.fund.gm}%`} | ${p.fund.gm === null ? '不适用' : `${round(p.fund.gm - 1.2, 1)}%`} | +1.2 个百分点 |`,
  `| 净利率 | ${p.fund.nm}% | ${round(p.fund.nm - 0.8, 1)}% | +0.8 个百分点 |`,
  `| 经营现金流 / 净利润 | ${p.fund.ocf}x | ${round(p.fund.ocf - 0.05, 2)}x | 稳定 |`,
  '',
  '## 管理层讨论与附注',
  '',
  '1. 管理层强调的变化：产品结构与成本控制。',
  '2. 回避的话题：个别业务线的利润率。',
  '3. 附注中的隐藏项：一次性收益、关联交易、或有负债。',
  '',
];

const managementBody = (p: Profile): string[] => [
  '## 关键人物',
  '',
  '- **CEO**：任期超过 8 年，战略连续',
  '- **CFO**：资本配置纪律良好',
  '',
  '## 评分',
  '',
  '| 维度 | 得分 | 说明 |',
  '| --- | :---: | --- |',
  `| 能力 | ${p.fund.mg}/5 | 业绩与既定目标的对比 |`,
  '| 诚信 | 4/5 | 承诺与兑现一致 |',
  '| 资本配置 | 4/5 | 回购、分红、并购回报 |',
  '',
  '## 如果 CEO 离开',
  '',
  '1. 业务是否依赖个人？依赖度中等。',
  '2. 继任安排是否清晰？董事会已有梯队。',
  '',
];

const newsBody = (p: Profile): string[] => [
  '## 四个侦察员的发现',
  '',
  '| 侦察员 | 关注点 | 发现 |',
  '| --- | --- | --- |',
  '| 公司事件 | 业绩、并购、人事 | 近 10 天无重大公告 |',
  '| 监管与政策 | 新规对盈利的影响 | 无新增，现有规则不变 |',
  '| 同行与行业 | 竞争对手动向 | 板块与大盘同步波动 |',
  '| 情绪 | 分析师评级、持仓 | 两次目标价调整，评级不变 |',
  '',
  '## 判断',
  '',
  `- 最近的价格波动主要由**市场**而非公司本身解释（${p.market === 'HK' ? '恒指' : '标普 500'}同步）`,
  '- 论文重审触发：**否**',
  '',
];

const thesisBody = (p: Profile): string[] => {
  const iv = intrinsicFor(p);
  return [
    '## 核心论点（不超过 200 字）',
    '',
    `我愿意在${p.contract ? money(p, p.contract.strike) : '内在价值以下'}持有${p.zhName}，因为它的 5 年平均 ROE 达 ${p.fund.roe5}%，现金流稳健，卖出 put 期间可以收取权利金。`,
    '',
    '## 需要每季度检查的假设',
    '',
    '| 假设 | 阈值 | 当前值 |',
    '| --- | ---: | ---: |',
    `| 营收 3 年复合增速 | >= ${Math.max(0, round(p.q.cagr - 3, 0))}% | ${p.q.cagr}% |`,
    `| 净负债 / EBITDA | <= 3x | ${p.q.nd === null ? '净现金' : `${p.q.nd}x`} |`,
    `| 自由现金流收益率 | >= 4% | ${p.q.fcf}% |`,
    '',
    '## 红线',
    '',
    '- 自由现金流连续两个季度为负',
    '- 管理层出现诚信问题',
    `- 股价跌破 ${money(p, (p.contract?.strike ?? iv.base ?? p.spot) * 0.85)} 且趋势走坏`,
    '',
    '## 估值锚',
    '',
    `内在价值 ${money(p, iv.base ?? p.spot)}（要求回报率 ${iv.requiredReturnPct}%），每次打开本论文时重新估算。`,
    '',
  ];
};

const TITLE: Record<SkillId, string> = {
  'quality-screen': '去劣筛选',
  'investment-checklist': '巴菲特买入前 Checklist',
  'investment-research': '四大师综合研究',
  'earnings-review': '财报精读',
  'management-deep-dive': '管理层纵深研究',
  'news-pulse': '新闻脉搏',
  'thesis-tracker': '论文追踪',
};

const BODY: Record<Exclude<SkillId, 'quality-screen'>, (p: Profile) => string[]> = {
  'investment-checklist': checklistBody,
  'investment-research': researchBody,
  'earnings-review': earningsBody,
  'management-deep-dive': managementBody,
  'news-pulse': newsBody,
  'thesis-tracker': thesisBody,
};

/** The Markdown an AI run "writes": mostly Chinese, with every Markdown feature the report viewer has to render. */
export function reportMarkdown(p: Profile, skillId: SkillId, date: string): string {
  if (skillId === 'quality-screen') return screenMarkdown(p, qualityScreen(p), date);
  return [...header(p, TITLE[skillId], date), ...BODY[skillId](p), ...footer(p, date)].join('\n');
}

/** The local quality screen, as Markdown (for the report.md download). */
export function screenMarkdown(p: Profile, screen: ScreenView, date: string): string {
  const label = { pass: '通过', warn: '临界', fail: '不通过', exempt: '豁免', na: '不适用' } as const;
  return [
    ...header(p, TITLE['quality-screen'], date),
    `**结论**：${screen.verdict}（临界项 ${screen.borderline} 个，数据窗口 ${screen.windowYears} 年）`,
    '',
    '| # | 过滤条件 | 数值 | 规则 | 结果 | 备注 |',
    '| ---: | --- | ---: | --- | :---: | --- |',
    ...screen.rows.map((r) => `| ${r.n} | ${r.label} | ${r.valueText} | ${r.rule} | ${label[r.status]} | ${r.note} |`),
    '',
  ].join('\n');
}
