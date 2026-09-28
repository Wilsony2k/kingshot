const App = (() => {
  let currentPage = 'home';
  let currentTheme = localStorage.getItem('theme') || 'dark';
  let currentLang = localStorage.getItem('lang') || 'zh-TW';
  let heroesData = [];
  let couponsData = [];

  const mainContent = document.getElementById('mainContent');
  const headerNav = document.getElementById('headerNav');
  const mobileDrawer = document.getElementById('mobileDrawer');
  const mobileDrawerOverlay = document.getElementById('mobileDrawerOverlay');
  const mobileMenuToggle = document.getElementById('mobileMenuToggle');
  const langToggle = document.getElementById('langToggle');
  const langMenu = document.getElementById('langMenu');
  const themeToggle = document.getElementById('themeToggle');
  const progressBar = document.getElementById('progressBar');
  const toastContainer = document.getElementById('toastContainer');
  const lastUpdateEl = document.getElementById('lastUpdate');

  const HERO_NAMES = {
    'Ava': '艾娃', 'Charles': '查爾斯', 'Wee & Woo': '威與烏',
    'Eric': '艾瑞克', 'Petra': '小佩拉', 'Jaeger': '耶格爾',
    'Alcar': '阿爾卡', 'Margot': '瑪爾戈', 'Rosa': '羅莎',
    'Longfei': '龍飛', 'Thrud': '斯露德', 'Vivian': '薇薇安',
    'Triton': '崔頓', 'Sophia': '蘇菲亞', 'Yang': '楊',
    'Amadeus': '阿瑪迪斯', 'Helga': '赫爾加', 'Jabel': '潔貝爾',
    'Saul': '薩洛', 'Howard': '霍華德', 'Gordon': '戈登',
    'Edwin': '艾德溫', 'Forrest': '福斯特', 'Seth': '史密斯',
    'Chenko': '琴科', 'Fahd': '法赫德', 'Yeonwoo': '妍羽',
    'Amane': '雨音', 'Diana': '狄安娜', 'Quinn': '奎恩',
    'Olive': '奧麗芙', 'Zoe': '佐伊', 'Hilde': '希爾德',
    'Marlin': '馬林', 'Sol': '索爾', 'Pera': '佩拉'
  };

  const UNIT_NAMES = {
    'heroes.card.ava.unit': '騎兵', 'heroes.card.charles.unit': '步兵',
    'heroes.card.wee-woo.unit': '弓兵', 'heroes.card.eric.unit': '步兵',
    'heroes.card.petra.unit': '騎兵', 'heroes.card.jaeger.unit': '弓兵',
    'heroes.card.alcar.unit': '步兵', 'heroes.card.margot.unit': '騎兵',
    'heroes.card.rosa.unit': '弓兵', 'heroes.card.longfei.unit': '步兵',
    'heroes.card.thrud.unit': '騎兵', 'heroes.card.vivian.unit': '弓兵',
    'heroes.card.triton.unit': '步兵', 'heroes.card.sophia.unit': '騎兵',
    'heroes.card.yang.unit': '弓兵', 'heroes.card.amadeus.unit': '步兵',
    'heroes.card.helga.unit': '步兵', 'heroes.card.jabel.unit': '騎兵',
    'heroes.card.saul.unit': '弓兵', 'heroes.card.howard.unit': '步兵',
    'heroes.card.gordon.unit': '騎兵', 'heroes.card.edwin.unit': '騎兵',
    'heroes.card.forrest.unit': '步兵', 'heroes.card.seth.unit': '步兵',
    'heroes.card.chenko.unit': '騎兵', 'heroes.card.fahd.unit': '騎兵',
    'heroes.card.yeonwoo.unit': '弓兵', 'heroes.card.amane.unit': '弓兵',
    'heroes.card.diana.unit': '弓兵', 'heroes.card.quinn.unit': '弓兵',
    'heroes.card.olive.unit': '弓兵', 'heroes.card.zoe.unit': '步兵(盾)',
    'heroes.card.hilde.unit': '騎兵', 'heroes.card.marlin.unit': '弓兵'
  };

  function getHeroName(hero) { return HERO_NAMES[hero.name] || hero.name; }
  function getHeroUnit(hero) { return UNIT_NAMES[hero.unit] || hero.unit || '-'; }

  const LANGUAGES = [
    { code: 'zh-TW', name: '繁體中文', flag: '🇹🇼' },
    { code: 'en', name: 'English', flag: '🇺🇸' }
  ];

  async function loadData() {
    try {
      const [heroesRes, couponsRes] = await Promise.all([
        fetch('/data/heroes.json'),
        fetch('/data/coupons.json')
      ]);
      heroesData = await heroesRes.json();
      const couponsJson = await couponsRes.json();
      couponsData = couponsJson.coupons || [];
      renderAllPages();
      showToast('數據載入完成！', 'success');
    } catch (error) {
      console.error('Failed to load data:', error);
      showToast('數據載入失敗', 'error');
    }
  }

  function init() {
    applyTheme(currentTheme);
    buildLangMenu();
    setupEventListeners();
    lastUpdateEl.textContent = new Date().toLocaleDateString('zh-TW');
    showToast('歡迎使用 Kingshot 資料庫！', 'info');
    loadData();
    navigateTo('home');
  }

  function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }

  function toggleTheme() {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
    showToast(`已切換至${currentTheme === 'dark' ? '深色' : '淺色'}模式`, 'info');
  }

  function applyLang(lang) {
    currentLang = lang;
    localStorage.setItem('lang', lang);
    renderAllPages();
    showToast('語言已切換', 'info');
  }

  function buildLangMenu() {
    const menus = [langMenu, document.getElementById('mobileLangMenu')];
    menus.forEach(menu => {
      if (!menu) return;
      menu.innerHTML = LANGUAGES.map(l => `<button class="lang-option ${l.code === currentLang ? 'active' : ''}" data-lang="${l.code}">${l.flag} ${l.name}</button>`).join('');
      menu.querySelectorAll('.lang-option').forEach(btn => btn.addEventListener('click', () => applyLang(btn.dataset.lang)));
    });
  }

  function renderAllPages() {
    mainContent.innerHTML = renderHome() + renderHeroes() + renderCoupons() + renderBuildings() + renderPets() + renderGuides() + renderCalculators() + renderAvgDaily();
  }

  function renderHome() {
    return `<section id="home" class="page active"><div class="container">
      <header class="hero-section">
        <h1 class="hero-title">KINGSHOT Avengers</h1>
        <p class="hero-subtitle">完整遊戲資料庫：英雄、建築、寵物、攻略、計算工具</p>
        <div class="hero-badges">
          <span class="badge badge-info">免費使用</span>
          <span class="badge badge-info">持續更新</span>
          <span class="badge badge-info">多語言支援</span>
        </div>
      </header>
      <section class="section">
        <h2 class="section-title"><span class="section-icon">📊</span>資料庫內容</h2>
        <div class="grid grid-4">
          <div class="stat-card"><div class="stat-value">${heroesData.length}</div><div class="stat-label">英雄數據</div><div class="stat-desc">所有世代完整屬性</div></div>
          <div class="stat-card"><div class="stat-value">${couponsData.length}</div><div class="stat-label">優惠碼</div><div class="stat-desc">即時更新優惠碼</div></div>
          <div class="stat-card"><div class="stat-value">7</div><div class="stat-label">世代英雄</div><div class="stat-desc">Gen 1 到 Gen 7</div></div>
          <div class="stat-card"><div class="stat-value">4</div><div class="stat-label">語言支援</div><div class="stat-desc">繁中/英/韓/日</div></div>
        </div>
      </section>
      <section class="section">
        <h2 class="section-title"><span class="section-icon">🎯</span>快速開始</h2>
        <div class="grid grid-4">
          <a href="#heroes" class="card btn-primary" style="text-align:center;text-decoration:none;color:white;" data-page="heroes"><div class="card-title">⚔️ 英雄圖鑑</div><p>查看所有英雄詳細屬性、技能、培養建議</p></a>
          <a href="#coupons" class="card btn-secondary" style="text-align:center;text-decoration:none;" data-page="coupons"><div class="card-title">🎁 優惠碼</div><p>最新有效優惠碼，免費領取獎勵</p></a>
          <a href="#calculators" class="card btn-secondary" style="text-align:center;text-decoration:none;" data-page="calculators"><div class="card-title">🧮 計算工具</div><p>鑽石計算機、碎片價值計算</p></a>
          <a href="#avgdaily" class="card btn-secondary" style="text-align:center;text-decoration:none;" data-page="avgdaily"><div class="card-title">📊 AVG DAILY</div><p>每日任務記錄與統計分析</p></a>
        </div>
      </section>
    </div></section>`;
  }

  function renderHeroes() {
    if (heroesData.length === 0) return `<section id="heroes" class="page"><div class="container"><div class="card"><div class="card-title">⚔️ 英雄圖鑑</div><p>載入中...</p></div></div></section>`;
    return `<section id="heroes" class="page"><div class="container">
      <header class="section"><h1 class="section-title"><span class="section-icon">⚔️</span>英雄圖鑑</h1><p>所有世代英雄完整數據</p></header>
      <section class="section">
        <h2 class="section-title"><span class="section-icon">📊</span>英雄總覽 (${heroesData.length})</h2>
        <div class="table-container"><table>
          <thead><tr><th>圖片</th><th>英雄</th><th>世代</th><th>兵種</th><th>征服攻擊</th><th>征服防禦</th></tr></thead>
          <tbody>
            ${heroesData.map(h => {
              const heroName = getHeroName(h);
              const unit = getHeroUnit(h);
              const atk = h.conquest?.stats?.find(s => s.label?.includes('Atk'))?.value || '-';
              const def = h.conquest?.stats?.find(s => s.label?.includes('Def'))?.value || '-';
              const imgUrl = h.image ? `https://kingshotdata.kr${h.image}` : '';
              return `<tr>
                <td>${imgUrl ? `<img src="${imgUrl}" alt="${heroName}" style="width:48px;height:48px;border-radius:8px;object-fit:cover;" onerror="this.style.display='none'">` : '🏹'}</td>
                <td><strong>${heroName}</strong><br><small style="color:var(--text-secondary)">${h.name}</small></td>
                <td>Gen ${h.generation}</td>
                <td>${unit}</td>
                <td>${atk}</td>
                <td>${def}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>
      </section>
    </div></section>`;
  }

  function renderCoupons() {
    if (couponsData.length === 0) return '';
    const now = new Date();
    const active = couponsData.filter(c => new Date(c.until) > now);
    const expired = couponsData.filter(c => new Date(c.until) <= now);
    return `<section id="coupons" class="page"><div class="container">
      <header class="section"><h1 class="section-title"><span class="section-icon">🎁</span>優惠碼</h1><p>最新有效優惠碼，免費領取獎勵！</p></header>
      <section class="section">
        <h2 class="section-title"><span class="section-icon">✅</span>有效優惠碼 (${active.length})</h2>
        <div class="grid grid-2">
          ${active.map(c => `<div class="card"><div class="card-title"><code style="font-size:1.1rem;padding:0.5rem 1rem;background:var(--bg-primary);border-radius:var(--radius);">${c.code}</code><button class="btn btn-secondary" onclick="navigator.clipboard.writeText('${c.code}').then(()=>this.textContent='已複製!')">複製</button></div><p>到期日：${c.until}</p></div>`).join('')}
        </div>
      </section>
      ${expired.length > 0 ? `<section class="section"><h2 class="section-title"><span class="section-icon">❌</span>已過期優惠碼 (${expired.length})</h2><div class="grid grid-2">${expired.slice(0, 6).map(c => `<div class="card" style="opacity:0.6;"><div class="card-title"><code style="font-size:1.1rem;padding:0.5rem 1rem;background:var(--bg-primary);border-radius:var(--radius);">${c.code}</code></div><p>到期日：${c.until}</p></div>`).join('')}</div></section>` : ''}
    </div></section>`;
  }

  function renderBuildings() {
    return `<section id="buildings" class="page"><div class="container">
      <header class="section"><h1 class="section-title"><span class="section-icon">🏗️</span>建築數據</h1><p>遊戲建築詳細數據與升級需求</p></header>
      <section class="section"><h2 class="section-title"><span class="section-icon">📊</span>建築總覽</h2><div class="grid grid-2">
        <div class="card"><div class="card-title">🏰 城堡</div><p>城堡是遊戲的核心建築，決定其他建築的等級上限。</p><ul style="margin-top:1rem;padding-left:1.5rem;"><li>每升一級提升部隊容量</li><li>解鎖新建築功能</li><li>提升資源產量</li></ul></div>
        <div class="card"><div class="card-title">⚔️ 兵營</div><p>兵營用於訓練各種兵種，提升兵種等級。</p><ul style="margin-top:1rem;padding-left:1.5rem;"><li>步兵營：訓練步兵單位</li><li>騎兵營：訓練騎兵單位</li><li>弓兵營：訓練弓兵單位</li></ul></div>
        <div class="card"><div class="card-title">🏠 資源建築</div><p>資源建築提供穩定的資源收入。</p><ul style="margin-top:1rem;padding-left:1.5rem;"><li>農場：生產糧食</li><li>伐木場：生產木材</li><li>鐵礦場：生產鐵礦</li><li>金礦場：生產金幣</li></ul></div>
        <div class="card"><div class="card-title">🔬 研究所</div><p>研究所用於解鎖科技，提升整體實力。</p><ul style="margin-top:1rem;padding-left:1.5rem;"><li>戰鬥科技：提升部隊屬性</li><li>經濟科技：提升資源產量</li><li>防禦科技：提升城防能力</li></ul></div>
      </div></section>
      <section class="section"><h2 class="section-title"><span class="section-icon">💡</span>建築升級建議</h2><div class="card"><div class="card-title">🎯 優先升級順序</div><p>建議新手玩家按照以下順序升級建築：</p><ol style="margin-top:1rem;padding-left:1.5rem;"><li><strong>城堡</strong> - 核心建築，優先升級</li><li><strong>資源建築</strong> - 保證資源供應</li><li><strong>兵營</strong> - 提升部隊實力</li><li><strong>研究所</strong> - 解鎖科技優勢</li></ol></div></section>
    </div></section>`;
  }

  function renderPets() {
    return `<section id="pets" class="page"><div class="container">
      <header class="section"><h1 class="section-title"><span class="section-icon">🐾</span>寵物系統</h1><p>寵物系統詳細介紹與培養指南</p></header>
      <section class="section"><h2 class="section-title"><span class="section-icon">📊</span>寵物總覽</h2><div class="grid grid-3">
        <div class="card"><div class="card-title">🐉 攻擊型寵物</div><p>攻擊型寵物專注於提升部隊攻擊力。</p><ul style="margin-top:1rem;padding-left:1.5rem;"><li>火焰龍：提升火屬性攻擊</li><li>雷電鷹：提升雷屬性攻擊</li><li>暗影狼：提升暗屬性攻擊</li></ul></div>
        <div class="card"><div class="card-title">🛡️ 防禦型寵物</div><p>防禦型寵物專注於提升部隊防禦力。</p><ul style="margin-top:1rem;padding-left:1.5rem;"><li>岩石巨人：提升物理防禦</li><li>冰霜熊：提升冰屬性防禦</li><li>光明騎士：提升光屬性防禦</li></ul></div>
        <div class="card"><div class="card-title">💊 輔助型寵物</div><p>輔助型寵物提供各種增益效果。</p><ul style="margin-top:1rem;padding-left:1.5rem;"><li>治療精靈：恢復部隊生命</li><li>速度兔：提升行軍速度</li><li>幸運貓：提升資源掉落</li></ul></div>
      </div></section>
    </div></section>`;
  }

  function renderGuides() {
    return `<section id="guides" class="page"><div class="container">
      <header class="section"><h1 class="section-title"><span class="section-icon">📖</span>攻略指南</h1><p>遊戲攻略與實用技巧</p></header>
      <section class="section"><h2 class="section-title"><span class="section-icon">🎯</span>新手攻略</h2><div class="grid grid-2">
        <div class="card"><div class="card-title">🚀 快速發展指南</div><p>新手玩家快速發展的關鍵步驟：</p><ol style="margin-top:1rem;padding-left:1.5rem;"><li>優先升級城堡到10級</li><li>完成所有新手任務</li><li>加入活躍聯盟</li><li>參與聯盟活動獲取獎勵</li></ol></div>
        <div class="card"><div class="card-title">💰 資源管理技巧</div><p>有效管理資源的建議：</p><ul style="margin-top:1rem;padding-left:1.5rem;"><li>合理分配資源產量</li><li>參與資源爭奪活動</li><li>使用資源保護道具</li><li>與聯盟成員交易資源</li></ul></div>
      </div></section>
    </div></section>`;
  }

  function renderCalculators() {
    return `<section id="calculators" class="page"><div class="container">
      <header class="section"><h1 class="section-title"><span class="section-icon">🧮</span>計算工具</h1><p>實用計算工具，幫助您更好地規劃遊戲</p></header>
      <section class="section"><h2 class="section-title"><span class="section-icon">💎</span>鑽石計算機</h2><div class="card">
        <div class="card-title">計算鑽石需求</div>
        <div class="grid grid-2" style="margin-top:1rem;">
          <div><label style="display:block;margin-bottom:0.5rem;font-weight:600;">當前等級</label><input type="number" id="currentLevel" value="1" min="1" max="100" style="width:100%;padding:0.75rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-primary);color:var(--text-primary);"></div>
          <div><label style="display:block;margin-bottom:0.5rem;font-weight:600;">目標等級</label><input type="number" id="targetLevel" value="10" min="1" max="100" style="width:100%;padding:0.75rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-primary);color:var(--text-primary);"></div>
        </div>
        <button class="btn btn-primary" style="margin-top:1rem;" onclick="window.calculateDiamonds()">計算鑽石需求</button>
        <div id="diamondResult" style="margin-top:1rem;padding:1rem;background:var(--bg-primary);border-radius:var(--radius-sm);display:none;"></div>
      </div></section>
    </div></section>`;
  }

  function navigateTo(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(pageId);
    if (target) {
      target.classList.add('active');
      currentPage = pageId;
      updateActiveNav();
      closeMobileMenu();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function reattachPageListeners() {
    document.querySelectorAll('[data-page]').forEach(el => {
      el.onclick = (e) => {
        e.preventDefault();
        navigateTo(el.dataset.page);
      };
    });
  }

  function updateActiveNav() {
    document.querySelectorAll('.header-nav-link, .mobile-drawer-link').forEach(link => {
      link.classList.toggle('active', link.dataset.page === currentPage);
    });
  }

  function closeMobileMenu() {
    if (mobileDrawer) mobileDrawer.classList.remove('open');
    if (mobileMenuToggle) mobileMenuToggle.setAttribute('aria-expanded', 'false');
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'slideIn 0.3s ease reverse';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function setupEventListeners() {
    document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(el.dataset.page);
    }));

    mobileMenuToggle?.addEventListener('click', () => {
      const isOpen = mobileDrawer.classList.toggle('open');
      mobileMenuToggle.setAttribute('aria-expanded', isOpen);
    });
    mobileDrawerOverlay?.addEventListener('click', closeMobileMenu);

    langToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      langMenu.classList.toggle('active');
    });
    document.addEventListener('click', (e) => {
      if (!langToggle?.contains(e.target) && !langMenu?.contains(e.target)) {
        langMenu?.classList.remove('active');
      }
    });

    themeToggle?.addEventListener('click', toggleTheme);
    document.getElementById('mobileThemeToggle')?.addEventListener('click', toggleTheme);

    window.addEventListener('scroll', () => {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      progressBar.style.transform = `scaleX(${docHeight > 0 ? scrollTop / docHeight : 0})`;
    }, { passive: true });
  }

  window.calculateDiamonds = function() {
    const currentLevel = parseInt(document.getElementById('currentLevel').value);
    const targetLevel = parseInt(document.getElementById('targetLevel').value);
    const resultDiv = document.getElementById('diamondResult');
    if (isNaN(currentLevel) || isNaN(targetLevel) || currentLevel >= targetLevel) {
      resultDiv.innerHTML = '<p style="color:var(--error);">請輸入有效的等級範圍</p>';
      resultDiv.style.display = 'block';
      return;
    }
    const diamondsNeeded = (targetLevel - currentLevel) * 100;
    const daysNeeded = Math.ceil(diamondsNeeded / 50);
    resultDiv.innerHTML = `<h4 style="margin-bottom:0.5rem;">計算結果</h4><p><strong>所需鑽石：</strong>${diamondsNeeded.toLocaleString()} 💎</p><p><strong>預計天數：</strong>${daysNeeded} 天（每日獲得50鑽石）</p>`;
    resultDiv.style.display = 'block';
    showToast('計算完成！', 'success');
  };

  // Daily Log Functions
  const DAILY_LOG_PASSWORD = 'Avengers';
  let dailyLogData = JSON.parse(localStorage.getItem('kingshot_daily_log') || '[]');

  function saveDailyLog() {
    localStorage.setItem('kingshot_daily_log', JSON.stringify(dailyLogData));
  }

  function getTodayDate() {
    return new Date().toISOString().split('T')[0];
  }

  function renderAvgDaily() {
    const today = getTodayDate();
    const todayLog = dailyLogData.find(log => log.date === today) || { date: today, content: '', tasks: [] };
    
    // Calculate statistics
    const totalDays = dailyLogData.length;
    const totalTasks = dailyLogData.reduce((sum, log) => sum + log.tasks.length, 0);
    const completedTasks = dailyLogData.reduce((sum, log) => sum + log.tasks.filter(t => t.done).length, 0);
    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    
    // Get streak days
    let streak = 0;
    const sortedLogs = dailyLogData.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    for (let i = 0; i < sortedLogs.length; i++) {
      const expectedDate = new Date();
      expectedDate.setDate(expectedDate.getDate() - i);
      const expectedDateStr = expectedDate.toISOString().split('T')[0];
      if (sortedLogs[i]?.date === expectedDateStr && sortedLogs[i]?.tasks.some(t => t.done)) {
        streak++;
      } else {
        break;
      }
    }
    
    return `<section id="avgdaily" class="page"><div class="container">
      <header class="section"><h1 class="section-title"><span class="section-icon">📊</span>AVG DAILY 日誌</h1><p>每日任務記錄與統計分析</p></header>
      
      <div class="section">
        <h2 class="section-title"><span class="section-icon">📈</span>統計總覽</h2>
        <div class="grid grid-4">
          <div class="stat-card"><div class="stat-value">${totalDays}</div><div class="stat-label">記錄天數</div><div class="stat-desc">總共記錄天數</div></div>
          <div class="stat-card"><div class="stat-value">${totalTasks}</div><div class="stat-label">總任務數</div><div class="stat-desc">所有任務總和</div></div>
          <div class="stat-card"><div class="stat-value">${completedTasks}</div><div class="stat-label">已完成任務</div><div class="stat-desc">已完成任務數</div></div>
          <div class="stat-card"><div class="stat-value">${completionRate}%</div><div class="stat-label">完成率</div><div class="stat-desc">任務完成百分比</div></div>
        </div>
      </div>
      
      <div class="section">
        <h2 class="section-title"><span class="section-icon">🔥</span>連續記錄</h2>
        <div class="card" style="text-align:center;">
          <div style="font-size:3rem;font-weight:900;color:var(--accent-gold);margin-bottom:0.5rem;">${streak} 天</div>
          <p style="color:var(--text-secondary);">連續完成任務天數</p>
          <p style="font-size:0.9rem;margin-top:0.5rem;">保持每日完成任務，維持連續記錄！</p>
        </div>
      </div>
      
      <div class="section">
        <div class="card" style="position:relative;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
            <div class="card-title">📅 ${today} 每日記錄</div>
            <button class="btn btn-secondary" id="editDailyBtn" onclick="window.openDailyEdit()">✏️ EDIT</button>
          </div>
          <div id="dailyLogContent">
            <div style="margin-bottom:1rem;">
              <h4 style="margin-bottom:0.5rem;">📝 備註</h4>
              <p style="color:var(--text-secondary);">${todayLog.content || '尚未填寫備註'}</p>
            </div>
            <div>
              <h4 style="margin-bottom:0.5rem;">✅ 任務清單</h4>
              ${todayLog.tasks.length > 0 ? 
                `<ul style="list-style:none;padding:0;">${todayLog.tasks.map((task, i) => 
                  `<li style="padding:0.5rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:0.5rem;">
                    <input type="checkbox" ${task.done ? 'checked' : ''} disabled style="width:18px;height:18px;">
                    <span style="${task.done ? 'text-decoration:line-through;color:var(--text-secondary);' : ''}">${task.text}</span>
                  </li>`
                ).join('')}</ul>` : 
                '<p style="color:var(--text-secondary);">尚未新增任務</p>'
              }
            </div>
          </div>
        </div>
      </div>
      
      <div class="section">
        <h2 class="section-title"><span class="section-icon">📋</span>快速任務模板</h2>
        <div class="grid grid-3">
          <div class="card" style="cursor:pointer;" onclick="window.addQuickTask('每日簽到')">
            <div class="card-title">🎮 每日簽到</div>
            <p style="color:var(--text-secondary);font-size:0.9rem;">點擊快速新增每日簽到任務</p>
          </div>
          <div class="card" style="cursor:pointer;" onclick="window.addQuickTask('聯盟任務')">
            <div class="card-title">⚔️ 聯盟任務</div>
            <p style="color:var(--text-secondary);font-size:0.9rem;">點擊快速新增聯盟任務</p>
          </div>
          <div class="card" style="cursor:pointer;" onclick="window.addQuickTask('資源收集')">
            <div class="card-title">💰 資源收集</div>
            <p style="color:var(--text-secondary);font-size:0.9rem;">點擊快速新增資源收集任務</p>
          </div>
        </div>
      </div>
      
      <div class="section">
        <h2 class="section-title"><span class="section-icon">📅</span>歷史記錄</h2>
        <div id="dailyHistory">
          ${dailyLogData.length > 0 ? 
            dailyLogData.slice().reverse().slice(0, 7).map(log => 
              `<div class="card" style="margin-bottom:1rem;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
                  <div class="card-title">📅 ${log.date}</div>
                  <span style="font-size:0.9rem;color:var(--text-secondary);">完成：${log.tasks.filter(t => t.done).length}/${log.tasks.length}</span>
                </div>
                <p style="color:var(--text-secondary);margin-bottom:0.5rem;">${log.content || '無備註'}</p>
                ${log.tasks.length > 0 ? 
                  `<div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-top:0.5rem;">
                    ${log.tasks.slice(0, 3).map(t => 
                      `<span style="font-size:0.8rem;padding:0.2rem 0.5rem;background:${t.done ? 'var(--success)' : 'var(--bg-primary)'};color:${t.done ? 'white' : 'var(--text-secondary)'};border-radius:999px;">${t.done ? '✓' : '○'} ${t.text}</span>`
                    ).join('')}
                    ${log.tasks.length > 3 ? `<span style="font-size:0.8rem;color:var(--text-secondary);">+${log.tasks.length - 3} 更多</span>` : ''}
                  </div>` : ''
                }
              </div>`
            ).join('') : 
            '<div class="card" style="text-align:center;padding:2rem;"><p style="color:var(--text-secondary);">暫無歷史記錄</p><p style="font-size:0.9rem;margin-top:0.5rem;">點擊 EDIT 開始記錄您的每日任務！</p></div>'
          }
        </div>
      </div>
    </div></section>`;
  }

  window.openDailyEdit = function() {
    const password = prompt('請輸入密碼以編輯日誌：');
    if (password !== DAILY_LOG_PASSWORD) {
      if (password !== null) {
        showToast('密碼錯誤！', 'error');
      }
      return;
    }

    const today = getTodayDate();
    const todayLog = dailyLogData.find(log => log.date === today) || { date: today, content: '', tasks: [] };
    
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;padding:1rem;';
    modal.id = 'dailyEditModal';
    
    modal.innerHTML = `
      <div style="background:var(--bg-card);border-radius:var(--radius-lg);padding:2rem;max-width:600px;width:100%;max-height:80vh;overflow-y:auto;box-shadow:var(--shadow-xl);">
        <h2 style="margin-bottom:1.5rem;display:flex;align-items:center;gap:0.5rem;">✏️ 編輯日誌 - ${today}</h2>
        <div style="margin-bottom:1.5rem;">
          <label style="display:block;margin-bottom:0.5rem;font-weight:600;">📝 備註</label>
          <textarea id="editDailyContent" style="width:100%;padding:0.75rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-primary);color:var(--text-primary);min-height:100px;resize:vertical;">${todayLog.content}</textarea>
        </div>
        <div style="margin-bottom:1.5rem;">
          <label style="display:block;margin-bottom:0.5rem;font-weight:600;">✅ 任務清單</label>
          <div id="editTaskList">
            ${todayLog.tasks.map((task, i) => `
              <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;" class="task-item">
                <input type="checkbox" ${task.done ? 'checked' : ''} onchange="window.toggleTask(${i})" style="width:18px;height:18px;">
                <input type="text" value="${task.text}" onchange="window.updateTaskText(${i}, this.value)" style="flex:1;padding:0.5rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-primary);color:var(--text-primary);">
                <button onclick="window.removeTask(${i})" style="background:var(--error);color:white;border:none;border-radius:var(--radius-sm);padding:0.5rem;cursor:pointer;">🗑️</button>
              </div>
            `).join('')}
          </div>
          <button onclick="window.addTask()" style="margin-top:0.5rem;padding:0.5rem 1rem;background:var(--info);color:white;border:none;border-radius:var(--radius-sm);cursor:pointer;">➕ 新增任務</button>
        </div>
        <div style="display:flex;gap:1rem;justify-content:flex-end;">
          <button onclick="window.closeDailyEdit()" style="padding:0.75rem 1.5rem;background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;">取消</button>
          <button onclick="window.saveDailyEdit()" style="padding:0.75rem 1.5rem;background:var(--accent);color:white;border:none;border-radius:var(--radius-sm);cursor:pointer;">💾 儲存</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    window._editingLog = todayLog;
  };

  window.closeDailyEdit = function() {
    const modal = document.getElementById('dailyEditModal');
    if (modal) modal.remove();
    window._editingLog = null;
  };

  window.addTask = function() {
    const log = window._editingLog;
    if (!log) return;
    log.tasks.push({ text: '新任務', done: false });
    window.openDailyEdit();
  };

  window.removeTask = function(index) {
    const log = window._editingLog;
    if (!log) return;
    log.tasks.splice(index, 1);
    window.openDailyEdit();
  };

  window.toggleTask = function(index) {
    const log = window._editingLog;
    if (!log) return;
    log.tasks[index].done = !log.tasks[index].done;
  };

  window.updateTaskText = function(index, text) {
    const log = window._editingLog;
    if (!log) return;
    log.tasks[index].text = text;
  };

  window.saveDailyEdit = function() {
    const log = window._editingLog;
    if (!log) return;
    
    log.content = document.getElementById('editDailyContent').value;
    
    const existingIndex = dailyLogData.findIndex(l => l.date === log.date);
    if (existingIndex >= 0) {
      dailyLogData[existingIndex] = log;
    } else {
      dailyLogData.push(log);
    }
    
    saveDailyLog();
    window.closeDailyEdit();
    renderAllPages();
    showToast('日誌已儲存！', 'success');
  };

  window.addQuickTask = function(taskName) {
    const today = getTodayDate();
    let todayLog = dailyLogData.find(log => log.date === today);
    
    if (!todayLog) {
      todayLog = { date: today, content: '', tasks: [] };
      dailyLogData.push(todayLog);
    }
    
    todayLog.tasks.push({ text: taskName, done: false });
    saveDailyLog();
    renderAllPages();
    showToast(`已新增任務：${taskName}`, 'success');
  };

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);