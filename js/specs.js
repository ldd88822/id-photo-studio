// 证件照规格库：mm -> px（按 DPI 换算）

export const MM_PER_INCH = 25.4;

const RAW = [
  {
    group: '常用',
    items: [
      ['一寸', 25, 35, '简历 / 资格证 / 各类报名'],
      ['小一寸', 22, 32, '社保卡 / 驾驶证'],
      ['大一寸', 33, 48, '护照 / 港澳通行证'],
      ['二寸', 35, 49, '简历 / 档案 / 资格证'],
      ['小二寸', 35, 45, '签证 / 公务员报名'],
      ['大二寸', 35, 53, '部分职业资格证'],
    ],
  },
  {
    group: '证件',
    items: [
      ['身份证', 26, 32, '第二代居民身份证'],
      ['护照', 33, 48, '中国因私普通护照'],
      ['港澳通行证', 33, 48, '往来港澳通行证'],
      ['台湾通行证', 33, 48, '往来台湾通行证'],
      ['驾驶证', 22, 32, '机动车驾驶证'],
      ['社保卡', 26, 32, '社会保障卡'],
      ['教师资格证', 25, 35, '教师资格认定'],
      ['执业医师', 25, 35, '医师资格考试'],
      ['法律职业资格', 25, 35, '法考报名'],
    ],
  },
  {
    group: '签证',
    items: [
      ['美国签证', 51, 51, '美签 2×2 英寸'],
      ['日本签证', 45, 45, '日签 45×45mm'],
      ['申根签证', 35, 45, '欧洲申根通用'],
      ['英国签证', 35, 45, '英签 35×45mm'],
      ['韩国签证', 35, 45, '韩签 35×45mm'],
      ['加拿大签证', 35, 45, '加签 35×45mm'],
      ['澳大利亚签证', 35, 45, '澳签 35×45mm'],
      ['泰国签证', 35, 45, '泰签 35×45mm'],
      ['印度签证', 51, 51, '印签 2×2 英寸'],
    ],
  },
  {
    group: '考试',
    items: [
      ['考研报名', 25, 35, '全国硕士研究生报名'],
      ['公务员国考', 35, 45, '国家公务员考试'],
      ['四六级', 25, 35, '大学英语四六级'],
      ['会计职称', 25, 35, '初级 / 中级会计'],
      ['一级建造师', 25, 35, '建造师考试'],
      ['监理工程师', 25, 35, '监理工程师考试'],
      ['软考', 25, 35, '计算机技术与软件'],
    ],
  },
];

let seq = 0;
export const SPEC_GROUPS = RAW.map((g) => ({
  group: g.group,
  items: g.items.map(([name, w, h, note]) => ({
    id: 's' + ++seq,
    name,
    mmW: w,
    mmH: h,
    note: note || '',
  })),
}));

export const ALL_SPECS = SPEC_GROUPS.flatMap((g) => g.items);

export function mmToPx(mm, dpi) {
  return Math.round((mm / MM_PER_INCH) * dpi);
}

export function specPx(spec, dpi) {
  return { w: mmToPx(spec.mmW, dpi), h: mmToPx(spec.mmH, dpi) };
}

export function findSpec(id) {
  return ALL_SPECS.find((s) => s.id === id) || ALL_SPECS[0];
}

// —— 底色预设 ——
export const BG_PRESETS = [
  { name: '白底', c1: '#ffffff', c2: '#ffffff', grad: false, common: true },
  { name: '蓝底', c1: '#438edb', c2: '#438edb', grad: false, common: true },
  { name: '红底', c1: '#e02b2b', c2: '#e02b2b', grad: false, common: true },
  { name: '渐变蓝', c1: '#4a8fd6', c2: '#e9f2fc', grad: true, common: true },
  { name: '渐变红', c1: '#d93b3b', c2: '#fbe6e6', grad: true, common: false },
  { name: '深蓝', c1: '#1c4f8f', c2: '#1c4f8f', grad: false, common: false },
  { name: '浅蓝', c1: '#9ec9ea', c2: '#9ec9ea', grad: false, common: false },
  { name: '灰色', c1: '#c9ced6', c2: '#c9ced6', grad: false, common: false },
  { name: '白渐变', c1: '#ffffff', c2: '#eef2f7', grad: true, common: false },
];

// —— 相纸 ——
export const PAPERS = {
  '6': { name: '6寸相纸', mmW: 102, mmH: 152 },
  '5': { name: '5寸相纸', mmW: 89, mmH: 127 },
  a4: { name: 'A4 纸', mmW: 210, mmH: 297 },
};
