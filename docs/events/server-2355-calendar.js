/**
 * Server 2355 專屬活動日曆資料與邏輯
 * 資料來源：官方 4 週循環日曆 + Kingshot 評分表 + 攻略庫
 * 強勢領主第 4 期以第 3 期資料替代（Day 6: 500分/點, Day 7: 300分/分）
 */

const CALENDAR_META = {
  server: '2355',
  serverAgeDay59Date: '2025-09-19', // 以 09/19 為 Day 59 基準
  timezone: 'UTC',
  strongestLordPeriod: 4, // 第 4 期，用第 3 期資料替代
  usePeriod3DataForPeriod4: true,
  lastUpdated: '2025-09-19',
  version: '1.0'
};

// 事件類型對應顏色/圖示
const EVENT_TYPES = {
  'strongest-lord': { label: '最強領主', color: '#e74c3c', icon: '👑', priority: 1 },
  'hero-assembly': { label: '英雄集結', color: '#9b59b6', icon: '🎯', priority: 2 },
  'hero-star-fund': { label: '英雄升星基金', color: '#8e44ad', icon: '💎', priority: 2 },
  'alliance-championship': { label: '聯盟爭霸戰', color: '#3498db', icon: '⚔️', priority: 3 },
  'alliance-brawl': { label: '聯盟大亂鬥', color: '#2980b9', icon: '🛡️', priority: 3 },
  'sanctuary-battle': { label: '聖地之戰', color: '#1abc9c', icon: '🏰', priority: 3 },
  'swordland-showdown': { label: '聖劍爭奪', color: '#16a085', icon: '⚔️', priority: 3 },
  'alliance-mobilization': { label: '聯盟總動員', color: '#27ae60', icon: '📋', priority: 4 },
  'officer-project': { label: '官員計畫', color: '#2ecc71', icon: '📝', priority: 4 },
  'golden-glaives': { label: '貿易復興', color: '#f39c12', icon: '💰', priority: 4 },
  'defeat-beasts': { label: '清理野獸', color: '#e67e22', icon: '🐺', priority: 4 },
  'vikings-vengeance': { label: '巨獸狩獵', color: '#d35400', icon: '🦣', priority: 3 },
  'all-out': { label: '全力衝刺', color: '#c0392b', icon: '🚀', priority: 3 },
  'kings-castle': { label: '王城戰', color: '#8e44ad', icon: '🏰', priority: 3 },
  'strongest-governor': { label: '最強領主(顯示名)', color: '#e74c3c', icon: '👑', priority: 1 },
  'governor-gear-enhancement': { label: '領主裝備強化', color: '#e74c3c', icon: '🛡️', priority: 1 },
  'kvk-matchmaking': { label: 'KvK 配對', color: '#e74c3c', icon: '🌍', priority: 1 },
  'kvk-prep': { label: 'KvK 備戰', color: '#e74c3c', icon: '📦', priority: 1 },
  'castle-battle': { label: 'KvK 城堡戰', color: '#e74c3c', icon: '🏰', priority: 1 },
  'wishful-emporium': { label: '許願商店', color: '#f39c12', icon: '🛍️', priority: 4 },
  'top-governor-gear': { label: '領主裝備榜', color: '#e74c3c', icon: '🏆', priority: 3 },
  'mystic-trial': { label: '荒野試煉', color: '#3498db', icon: '🏜️', priority: 4 },
  'ruins-contest': { label: '遺跡爭奪', color: '#8e44ad', icon: '🏺', priority: 4 },
  'town-development': { label: '城鎮發展', color: '#27ae60', icon: '🏗️', priority: 4 },
  'lost-ruins': { label: '失落遺跡', color: '#8e44ad', icon: '🗝️', priority: 4 },
  'beastmaster': { label: '馴獸師達人', color: '#1abc9c', icon: '🐾', priority: 4 },
  'truegold-start': { label: '真金時代開啟', color: '#f1c40f', icon: '✨', priority: 1 },
  'gen2-pets': { label: '第2代寵物釋出', color: '#1abc9c', icon: '🦌', priority: 2 }
};

// 強勢領主每日主題（第 3 期資料，作為第 4 期替代）
const STRONGEST_LORD_DAYS = [
  {
    day: 1,
    theme: '城鎮建設',
    themeEn: 'Town Development',
    mainTasks: [
      { task: '研究科技（優先）', score: '45分/實力', roi: '~750分/分', must: true },
      { task: '升級建築', score: '45分/實力', roi: '視建築而定', must: true },
      { task: '訓練/晉升士兵', score: '20分/實力', roi: '較低', must: false }
    ],
    keyResources: ['加速→Academy', '資源→建築'],
    saveResources: ['轉盤幣', '信物', '組件', '錘', '印記', '秘銀']
  },
  {
    day: 2,
    theme: '英雄成長',
    themeEn: 'Hero Growth',
    mainTasks: [
      { task: '英雄轉盤 120抽', score: '90,000分/次', roi: '最高', must: true },
      { task: '傳說英雄信物升星', score: '35,000分/個', roi: '極高', must: true },
      { task: '史詩英雄信物升星', score: '14,000分/個', roi: '高', must: false },
      { task: '稀有英雄信物升星', score: '4,000分/個', roi: '中', must: false },
      { task: '採集資源', score: '3分/項', roi: '低', must: false }
    ],
    keyResources: ['鑽石 16.2萬', '轉盤幣 108', '傳說/史詩/稀有信物'],
    saveResources: ['加速', '資源', '組件', '錘', '印記', '秘銀']
  },
  {
    day: 3,
    theme: '訓練士兵',
    themeEn: 'Train Troops',
    mainTasks: [
      { task: '訓練 10級士兵', score: '1,960分/隻', roi: '3,267分/分', must: true },
      { task: '訓練 9級士兵', score: '1,485分/隻', roi: '2,475分/分', must: true },
      { task: '訓練 8級士兵', score: '1,130分/隻', roi: '1,883分/分', must: false },
      { task: '訓練 7級以下', score: '遞減', roi: '遞減', must: false },
      { task: '卡點 00:00 後完成', score: '雙倍收益', roi: '雙倍', must: true }
    ],
    keyResources: ['糧食', '加速', '訓練隊列', 'Drill Camp'],
    saveResources: ['轉盤幣', '信物', '組件', '錘', '印記', '秘銀']
  },
  {
    day: 4,
    theme: '狩獵野獸',
    themeEn: 'Hunt Beasts',
    mainTasks: [
      { task: '發起集結巨獸', score: '90,000分', roi: '極高', must: true },
      { task: '擊殺 30級野獸', score: '30,000分/隻', roi: '高', must: true }
    ],
    keyResources: ['體力', '聯盟戰令', '集結令', '主力英雄'],
    saveResources: ['加速', '資源', '轉盤幣', '信物', '組件', '錘', '印記', '秘銀']
  },
  {
    day: 5,
    theme: '實力衝刺',
    themeEn: 'Power Sprint',
    mainTasks: [
      { task: '消耗英雄專屬裝備組件', score: '100,000分/個', roi: '最高', must: true },
      { task: '消耗英雄裝備鍛造錘', score: '50,000分/個', roi: '極高', must: true },
      { task: '研究/建造/訓練補實力', score: '30/30/20分/實力', roi: '中', must: false }
    ],
    keyResources: ['組件', '錘', '加速', '資源'],
    saveResources: ['印記', '秘銀', '轉盤幣', '信物']
  },
  {
    day: 6,
    theme: '領主提升',
    themeEn: 'Governor Enhancement',
    mainTasks: [
      { task: '領主裝備突破/洗鍊提升評分', score: '500分/點', roi: '極高(>>KVK 70/36)', must: true },
      { task: '建造/研究/訓練補分', score: '30/30/20分/實力', roi: '中', must: false }
    ],
    keyResources: ['突破石', '洗鍊石', '加速', '資源'],
    saveResources: ['印記', '秘銀', '組件', '錘']
  },
  {
    day: 7,
    theme: '加速專項',
    themeEn: 'Speedup Special',
    mainTasks: [
      { task: '消耗所有加速道具（建造/研究/訓練/晉升）', score: '300分/分 = 18,000分/時', roi: '全遊戲最高', must: true },
      { task: '英雄信物補尾', score: '35k/14k/4k', roi: '高', must: false }
    ],
    keyResources: ['所有加速道具'],
    saveResources: ['印記', '秘銀', '組件', '錘']
  }
];

// 完整 4 週活動資料（09/14 - 10/11）
const WEEKS_DATA = [
  {
    week: 1,
    label: 'Week 1 (09/14–09/20)',
    startDate: '2025-09-14',
    endDate: '2025-09-20',
    days: [
      {
        date: '2025-09-14',
        serverDay: 54,
        isToday: false,
        events: [
          { id: 'alliance-championship', day: 1 },
          { id: 'alliance-brawl', day: 1 },
          { id: 'swordland-showdown', day: 1 }
        ],
        strongestLordDay: null,
        notes: '四大活動同週起・聯盟戰令給核心・被動防守・高級印記/加速/核心資源全禁用'
      },
      {
        date: '2025-09-15',
        serverDay: 55,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 1 },
          { id: 'alliance-championship', day: 2 },
          { id: 'alliance-brawl', day: 2 },
          { id: 'swordland-showdown', day: 2 }
        ],
        strongestLordDay: null,
        notes: '免費探索/聯盟任務門檻・商店限購・純免費玩'
      },
      {
        date: '2025-09-16',
        serverDay: 56,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 2 },
          { id: 'alliance-championship', day: 3 },
          { id: 'alliance-brawl', day: 3 },
          { id: 'swordland-showdown', day: 3 },
          { id: 'mystic-trial', day: 1 }
        ],
        strongestLordDay: null,
        notes: '免費參與/荒野的試煉・順手完成'
      },
      {
        date: '2025-09-17',
        serverDay: 57,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 3 },
          { id: 'alliance-championship', day: 4 },
          { id: 'alliance-brawl', day: 4 },
          { id: 'swordland-showdown', day: 4 },
          { id: 'golden-glaives', day: 1 }
        ],
        strongestLordDay: null,
        notes: '派免費商隊(用倉庫溢出)/聯盟任務門檻・只用溢出資源'
      },
      {
        date: '2025-09-18',
        serverDay: 58,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 4 },
          { id: 'alliance-championship', day: 5 },
          { id: 'alliance-brawl', day: 5 },
          { id: 'swordland-showdown', day: 5 },
          { id: 'town-development', day: 1 }
        ],
        strongestLordDay: null,
        notes: '免費建造/研究/聯盟任務門檻・禁用額外加速建造・最強領主週日開啟！'
      },
      {
        date: '2025-09-19',
        serverDay: 59,
        isToday: true,
        events: [
          { id: 'alliance-championship', day: 6 },
          { id: 'alliance-brawl', day: 6 },
          { id: 'swordland-showdown', day: 6 },
          { id: 'alliance-mobilization', day: 6 },
          { id: 'beastmaster', day: 6 }
        ],
        strongestLordDay: null,
        notes: '【今日 Day 59】清任務/領聯盟寶箱/商店限購・全資源預留最強領主'
      },
      {
        date: '2025-09-20',
        serverDay: 60,
        isToday: false,
        events: [
          { id: 'alliance-championship', day: 7 },
          { id: 'alliance-brawl', day: 7 },
          { id: 'swordland-showdown', day: 7 },
          { id: 'officer-project', day: 1 }
        ],
        strongestLordDay: null,
        notes: '免費任務/英雄集結①收尾・明天最強領主週開始'
      }
    ]
  },
  {
    week: 2,
    label: 'Week 2 (09/21–09/27) - 最強領主核心週',
    startDate: '2025-09-21',
    endDate: '2025-09-27',
    days: [
      {
        date: '2025-09-21',
        serverDay: 61,
        isToday: false,
        events: [
          { id: 'alliance-championship', day: 8 },
          { id: 'officer-project', day: 2 },
          { id: 'golden-glaives', day: 2 }
        ],
        strongestLordDay: 1,
        notes: '【最強領主 Day 1 城鎮建設】研究科技優先(45分/實力)・Officer Project 2=英雄計畫(免費做)・聯盟戰零資源'
      },
      {
        date: '2025-09-22',
        serverDay: 62,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 5 },
          { id: 'alliance-championship', day: 9 },
          { id: 'golden-glaives', day: 3 }
        ],
        strongestLordDay: 2,
        notes: '【最強領主 Day 2 英雄成長】轉盤 120抽/傳說信物升星・Golden Glaives=貿易復興(只用溢出)・單日最高分日！'
      },
      {
        date: '2025-09-23',
        serverDay: 63,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 6 },
          { id: 'alliance-championship', day: 10 },
          { id: 'defeat-beasts', day: 1 }
        ],
        strongestLordDay: 3,
        notes: '【最強領主 Day 3 訓練士兵】訓練 10/9級兵滿隊列・卡點 00:00 後完成・Defeat Beasts=清理野獸(免費做)・ROI最高 3267分/分'
      },
      {
        date: '2025-09-24',
        serverDay: 64,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 7 },
          { id: 'alliance-championship', day: 11 },
          { id: 'vikings-vengeance', day: 1 }
        ],
        strongestLordDay: 4,
        notes: '【最強領主 Day 4 狩獵野獸】集結巨獸(90k)/擊殺30級野獸(30k)・Vikings Vengeance=巨獸雙倍收益！・聯盟戰令/體力唯一給這裡'
      },
      {
        date: '2025-09-25',
        serverDay: 65,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 8 },
          { id: 'alliance-championship', day: 12 },
          { id: 'all-out', day: 1 }
        ],
        strongestLordDay: 5,
        notes: '【最強領主 Day 5 實力衝刺】組件(100k/個)/錘(50k/個)→Gen2主力・All Out=實力衝刺・組件/錘極稀缺只給新世代主力'
      },
      {
        date: '2025-09-26',
        serverDay: 66,
        isToday: false,
        events: [
          { id: 'alliance-championship', day: 13 },
          { id: 'kings-castle', day: 1 },
          { id: 'all-out', day: 2 }
        ],
        strongestLordDay: 6,
        notes: '【最強領主 Day 6 領主提升】領主裝備突破/洗鍊(500分/點)・King\'s Castle=王城戰第2輪・Governor Gear Enhancement=Day 6主題'
      },
      {
        date: '2025-09-27',
        serverDay: 67,
        isToday: false,
        events: [
          { id: 'alliance-championship', day: 14 },
          { id: 'strongest-governor', day: 1 },
          { id: 'governor-gear-enhancement', day: 1 }
        ],
        strongestLordDay: 7,
        notes: '【最強領主 Day 7 加速專項(第3期替代)】消耗所有加速(300分/分=1.8萬/時)・Strongest Governor=最強領主・Governor Gear Enhancement=Day 6主題・全遊戲最高加速ROI'
      }
    ]
  },
  {
    week: 3,
    label: 'Week 3 (09/28–10/04) - 真金開啟/集結②解凍/KvK備戰',
    startDate: '2025-09-28',
    endDate: '2025-10-04',
    days: [
      {
        date: '2025-09-28',
        serverDay: 68,
        isToday: false,
        events: [
          { id: 'alliance-championship', day: 15 },
          { id: 'alliance-mobilization', day: 1 },
          { id: 'swordland-showdown', day: 8 }
        ],
        strongestLordDay: null,
        notes: '最強領主結束・英雄集結②解凍正常推進・清商店/抽目標英雄'
      },
      {
        date: '2025-09-29',
        serverDay: 69,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 9 },
          { id: 'alliance-championship', day: 16 },
          { id: 'alliance-mobilization', day: 2 },
          { id: 'truegold-start', day: 1 }
        ],
        strongestLordDay: null,
        notes: '🎉 真金時代開始・城鎮中心突破 Lv.30・真金建築開啟・囤真金材料/加速・Gen 2 寵物 2天后出'
      },
      {
        date: '2025-09-30',
        serverDay: 70,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 10 },
          { id: 'alliance-championship', day: 17 },
          { id: 'alliance-mobilization', day: 3 }
        ],
        strongestLordDay: null,
        notes: '英雄集結②/基金正常推進'
      },
      {
        date: '2025-10-01',
        serverDay: 71,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 11 },
          { id: 'alliance-championship', day: 18 },
          { id: 'alliance-mobilization', day: 4 },
          { id: 'gen2-pets', day: 1 }
        ],
        strongestLordDay: null,
        notes: 'Gen 2 寵物釋出(駝鹿/獵豹/野牛/猞猁)・高級印記產出・仍禁用於 KVK/馴獸師，留最強領主第三期 Day 4'
      },
      {
        date: '2025-10-02',
        serverDay: 72,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 12 },
          { id: 'alliance-championship', day: 19 },
          { id: 'alliance-mobilization', day: 5 }
        ],
        strongestLordDay: null,
        notes: '正常推進'
      },
      {
        date: '2025-10-03',
        serverDay: 73,
        isToday: false,
        events: [
          { id: 'alliance-championship', day: 20 },
          { id: 'alliance-mobilization', day: 6 },
          { id: 'swordland-showdown', day: 9 }
        ],
        strongestLordDay: null,
        notes: '正常推進'
      },
      {
        date: '2025-10-04',
        serverDay: 74,
        isToday: false,
        events: [
          { id: 'alliance-championship', day: 21 },
          { id: 'swordland-showdown', day: 10 },
          { id: 'kvk-matchmaking', day: 1 }
        ],
        strongestLordDay: null,
        notes: '首次 KvK 備戰階段啟動・依評分表備戰階段 1 任務全開'
      }
    ]
  },
  {
    week: 4,
    label: 'Week 4 (10/05–10/11) - KVK 備戰階段/真金適應',
    startDate: '2025-10-05',
    endDate: '2025-10-11',
    days: [
      {
        date: '2025-10-05',
        serverDay: 75,
        isToday: false,
        events: [
          { id: 'alliance-championship', day: 22 },
          { id: 'kvk-prep', day: 1 },
          { id: 'golden-glaives', day: 4 }
        ],
        strongestLordDay: null,
        notes: 'KVK 備戰階段 1 全啟動：寶石/黃金/加速/瞭望塔'
      },
      {
        date: '2025-10-06',
        serverDay: 76,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 13 },
          { id: 'alliance-championship', day: 23 },
          { id: 'kvk-prep', day: 2 }
        ],
        strongestLordDay: null,
        notes: '備戰階段 2：轉盤/碎片/採集'
      },
      {
        date: '2025-10-07',
        serverDay: 77,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 14 },
          { id: 'alliance-championship', day: 24 },
          { id: 'kvk-prep', day: 3 }
        ],
        strongestLordDay: null,
        notes: '備戰階段 3：寵物/轉盤/碎片/瞭望塔'
      },
      {
        date: '2025-10-08',
        serverDay: 78,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 15 },
          { id: 'alliance-championship', day: 25 },
          { id: 'kvk-prep', day: 4 }
        ],
        strongestLordDay: null,
        notes: '備戰階段 4：寶石/鍛造錘/組件/訓練/採集'
      },
      {
        date: '2025-10-09',
        serverDay: 79,
        isToday: false,
        events: [
          { id: 'sanctuary-battle', day: 16 },
          { id: 'alliance-championship', day: 26 },
          { id: 'kvk-prep', day: 5 }
        ],
        strongestLordDay: null,
        notes: '備戰階段 5：寵物/寶石/鍛造錘/組件/黃金/加速/瞭望塔/採集'
      },
      {
        date: '2025-10-10',
        serverDay: 80,
        isToday: false,
        events: [
          { id: 'alliance-championship', day: 27 },
          { id: 'castle-battle', day: 1 },
          { id: 'all-out', day: 3 }
        ],
        strongestLordDay: null,
        notes: '🌍 首次 KvK 城堡戰 / SvS 正式開打・全聯盟協同巨獸/集結/情報事件'
      },
      {
        date: '2025-10-11',
        serverDay: 81,
        isToday: false,
        events: [
          { id: 'alliance-championship', day: 28 },
          { id: 'wishful-emporium', day: 1 },
          { id: 'top-governor-gear', day: 1 }
        ],
        strongestLordDay: null,
        notes: '許願商店/領主裝備榜・視餘力參與'
      }
    ]
  }
];

// 資源預算模板（使用者可編輯）
const DEFAULT_RESOURCE_BUDGET = {
  spinCoins: 0,           // 轉盤幣/幸運幣
  legendaryTokens: 0,     // 傳說英雄信物
  epicTokens: 0,          // 史詩英雄信物
  rareTokens: 0,          // 稀有英雄信物
  advancedTamingMarks: 0, // 高級馴化印記
  normalTamingMarks: 0,   // 普通馴化印記
  heroExclusiveParts: 0,  // 英雄專屬裝備組件
  heroForgeHammers: 0,    // 英雄裝備鍛造錘
  mithril: 0,             // 秘銀
  speedups: 0,            // 加速道具(萬分鐘)
  diamonds: 0             // 鑽石
};

// 工具函數
function getEventTypeInfo(eventId) {
  return EVENT_TYPES[eventId] || { label: eventId, color: '#95a5a6', icon: '📌', priority: 5 };
}

function getStrongestLordDayInfo(day) {
  if (day < 1 || day > 7) return null;
  return STRONGEST_LORD_DAYS[day - 1];
}

function getWeekData(weekIndex) {
  return WEEKS_DATA[weekIndex] || null;
}

function getAllDays() {
  return WEEKS_DATA.flatMap(w => w.days);
}

function getDayByDate(dateStr) {
  const allDays = getAllDays();
  return allDays.find(d => d.date === dateStr) || null;
}

function getCurrentWeekIndex() {
  const today = new Date().toISOString().split('T')[0];
  for (let i = 0; i < WEEKS_DATA.length; i++) {
    const week = WEEKS_DATA[i];
    if (today >= week.startDate && today <= week.endDate) return i;
  }
  // 如果今天不在範圍內，回傳最接近的週
  for (let i = 0; i < WEEKS_DATA.length; i++) {
    if (today < WEEKS_DATA[i].startDate) return Math.max(0, i - 1);
  }
  return WEEKS_DATA.length - 1;
}

// 導出供 HTML 使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CALENDAR_META,
    EVENT_TYPES,
    STRONGEST_LORD_DAYS,
    WEEKS_DATA,
    DEFAULT_RESOURCE_BUDGET,
    getEventTypeInfo,
    getStrongestLordDayInfo,
    getWeekData,
    getAllDays,
    getDayByDate,
    getCurrentWeekIndex
  };
}