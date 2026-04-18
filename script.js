
/* ═══════════════════════════════════════════════════════════════

   ─── Estado Global ───

═══════════════════════════════════════════════════════════════ */

const state = {

    role: 'jogador',

    playerName: 'Jogador',

    zoom: 1, pan: { x: 100, y: 100 },

    gridSize: 60, opacity: 0.45,

    gridType: 'square',    

    /* 'square' | 'hex-v' | 'hex-h' */

    mapWidth: 1200, mapHeight: 800,

    fogCells: new Set(),

    mode: 'move',

    initiative: [], initiativeTurn: 0, showTracker: false,

    ruler: null,

    isFogPainting: false, isRulerActive: false,

    fogDragStart: null, fogDragMoved: false,

    pendingTokenSize: 1,

    activeLayer: 0,        /* camada ativa (0, 1, 2) */

    maps: { 0: null, 1: null, 2: null }, /* Mapas de cada layer */

    backup: null, /* Usado para o Desfazer Reset Geral */

    selectedTokenIds: new Set() /* IDs de tokens selecionados (seleção retangular) */

};

/* ─── Refs ─── */

const viewport     = document.getElementById('viewport');

const container    = document.getElementById('map-container');

const mapImg       = document.getElementById('active-map');

const gridOverlay  = document.getElementById('grid-overlay');

const hexCanvas    = document.getElementById('hex-grid-canvas');

const hexCtx       = hexCanvas.getContext('2d');

const fogCanvas    = document.getElementById('fog-canvas');

const rulerCanvas  = document.getElementById('ruler-canvas');

const fogCtx       = fogCanvas.getContext('2d');

const rulerCtx     = rulerCanvas.getContext('2d');

const ctxMenu      = document.getElementById('ctx-menu');

let ctxTokenId     = null;

const tokenDataMap = {};

/* id → dados locais do token */

function _el(id) { return document.getElementById(id); }

/* ─── Render inicial ─── */

renderMap();

/* ═══════════════════════════════════════════════════════════════

   ─── Entrada / Autenticação ───

═══════════════════════════════════════════════════════════════ */

window.confirmName = () => {

    const nameInput = _el('setup-name-input');

    const name = nameInput ? nameInput.value.trim() : '';

    if (!name) { nameInput && nameInput.focus(); return; }

    state.playerName = name;

    _el('setup-step-name').style.display = 'none';

    _el('setup-step-role').style.display = 'block';

    const greeting = _el('setup-name-greeting');

    if (greeting) greeting.innerText = 'Olá, ' + name + '! Como deseja entrar?';

};

/* Suporte ao Enter no campo de nome */

const attachNameEnter = () => {

    const ni = _el('setup-name-input');

    if (ni) ni.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.confirmName(); });

};

document.addEventListener('DOMContentLoaded', attachNameEnter);

setTimeout(attachNameEnter, 0);

window.startVTT = async (role) => {

    /* Garante que o Firebase foi inicializado antes de prosseguir */

    if (!window.vtt) {

        _el('auth-log').innerText = 'Firebase não inicializado. Recarregue a página.';

        return;

    }

    const { auth, signInAnonymously } = window.vtt;

    state.role = role;

    if (!state.playerName) state.playerName = role === 'mestre' ? 'Mestre' : 'Jogador';

    if (role === 'mestre') document.body.classList.add('is-mestre');

    _el('role-label').innerText = state.playerName + ' (' + (role === 'mestre' ? 'Mestre' : 'Jogador') + ')';

    _el('auth-log').innerText = 'Conectando ao servidor...';

    try {

        await signInAnonymously(auth);

        _el('setup-modal').style.display = 'none';

        _el('sync-dot').classList.remove('sync-dot-offline');

        _el('sync-dot').classList.add('sync-dot-online');

        _el('sync-dot').title = 'Conectado';

        initSync();

        initPresence();

    } catch (err) {

        _el('auth-log').innerText = 'Erro: ' + (err.message || 'falha na conexão');

        console.error('[VTT] Erro ao autenticar:', err);

    }

};

/* ═══════════════════════════════════════════════════════════════

   ─── Mobile Menu ───

═══════════════════════════════════════════════════════════════ */

window.toggleMobileMenu = () => {

    const sb = _el('sidebar');

    const ov = _el('mobile-overlay');

    const open = sb.classList.toggle('mobile-open');

    ov.style.display = open ? 'block' : 'none';

};

window.closeMobileMenu = () => {

    _el('sidebar').classList.remove('mobile-open');

    _el('mobile-overlay').style.display = 'none';

};

/* ═══════════════════════════════════════════════════════════════

   ─── Firestore Sync ───

═══════════════════════════════════════════════════════════════ */

async function initSync() {

    const { db, appId, onSnapshot, doc, setDoc, getDoc, collection } = window.vtt;

    const worldRef = doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current');

    /* Inicializa o documento somente se não existir (não sobrescreve mapa salvo) */

    try {

        const existingSnap = await getDoc(worldRef);

        if (!existingSnap.exists()) {

            await setDoc(worldRef, {

                grid: 60, opacity: 0.45, gridType: 'square',

                maps: { 0: null, 1: null, 2: null }, // Substituindo mapUrl antigo

                camera: { zoom: 1, pan: { x: 100, y: 100 } },

                fog: [], initiative: [], initiativeTurn: 0, showTracker: false, ping: null,

                activeLayer: 0

            });

        }

    } catch (e) { console.error('[VTT] Erro ao verificar documento world:', e); }

    /* Listener em tempo real do estado do mundo */

    onSnapshot(worldRef, (snap) => {

        if (!snap.exists()) return;

        const d = snap.data();

        state.gridSize  = d.grid    ?? 60;

        state.opacity   = d.opacity ?? 0.45;



        /* Atualiza tipo de grade somente se vier diferente */

        if (d.gridType && d.gridType !== state.gridType) {

            state.gridType = d.gridType;

            applyGridTypeUI(state.gridType);

        }



        if (d.activeLayer !== undefined) state.activeLayer = d.activeLayer;

        /* Lida com a nova estrutura de mapas ou fallback para o antigo */

        if (d.maps) {

            state.maps = d.maps;

        } else {

            state.maps = {

                0: { url: d.mapUrl || '', width: d.mapWidth || 1200, height: d.mapHeight || 800 },

                1: null, 2: null

            };

        }

        /* Câmera: somente jogadores seguem a câmera sincronizada */

        if (state.role === 'jogador' && d.camera) {

            state.zoom = d.camera.zoom;

            state.pan  = { ...d.camera.pan };

        }

        /* Aplica o mapa correspondente à camada atual */

        applyMapForCurrentLayer();

        /* Névoa — atualiza para todos */

        state.fogCells = new Set(d.fog ?? []);

        /* Sincronia do novo Tracker de Iniciativa */

        state.initiative     = d.initiative     ?? [];

        state.initiativeTurn = d.initiativeTurn ?? 0;

        state.showTracker    = d.showTracker    ?? false;

        renderFloatingInitiative();

        if (d.ping && d.ping.ts && (Date.now() - d.ping.ts) < 4000) {

            showPing(d.ping.x, d.ping.y);

        }

        renderMap();

    }, (e) => console.error('[VTT] Sync mundo:', e));

    /* Tokens em tempo real */

    onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'tokens'), (snap) => {

        snap.docChanges().forEach(change => {

            if (change.type === 'removed') {

                _el('tw-' + change.doc.id)?.remove();

                delete tokenDataMap[change.doc.id];

            } else {

                updateTokenDOM(change.doc.id, change.doc.data());

            }

        });

    }, (e) => console.error('[VTT] Sync tokens:', e));

    /* Histórico de rolagens */

    onSnapshot(

        collection(db, 'artifacts', appId, 'public', 'data', 'dice-rolls'),

        (snap) => {

            const entries = [];

            snap.forEach(d => entries.push({ id: d.id, ...d.data() }));

            entries.sort((a, b) => b.ts - a.ts);

            renderDiceHistory(entries.slice(0, 40));

        },

        (e) => console.error('[VTT] Sync dados:', e)

    );

    /* Fichas salvas */

    initPresets();

    /* Mapas salvos */

    initMapPresets();

}

/* Aplica a imagem de mapa correta baseado na camada ativa (layer 0, 1, 2) */

function applyMapForCurrentLayer() {

    const currentMap = state.maps[state.activeLayer] || { url: '', width: 1200, height: 800 };

    state.mapWidth = currentMap.width || 1200;

    state.mapHeight = currentMap.height || 800;

    if (currentMap.url && currentMap.url !== '') {

        if (mapImg.getAttribute('data-src') !== currentMap.url) {

            mapImg.setAttribute('data-src', currentMap.url);

            mapImg.src = currentMap.url;

            mapImg.style.display = 'block';

        }

    } else {

        mapImg.style.display = 'none';

        mapImg.removeAttribute('src');

        mapImg.removeAttribute('data-src');

    }

    renderMap();

}

/* ═══════════════════════════════════════════════════════════════

   ─── Utilitários de coordenada ───

═══════════════════════════════════════════════════════════════ */

function snapToGrid(v) { return Math.round(v / state.gridSize) * state.gridSize; }

/* Snap para grade hexagonal — retorna { x, y } já snappados */

function snapHex(rawX, rawY) {

    const gs = state.gridSize;

    if (state.gridType === 'hex-v') {

        /* Hexagonais de flat-top (vertical) usando coordenadas axiais */

        const w  = gs;

        const h  = gs * Math.sqrt(3) / 2;   /* altura de célula */

        const col = Math.round(rawX / (w * 0.75));

        const rowOffset = (col % 2 === 0) ? 0 : h / 2;

        const row = Math.round((rawY - rowOffset) / h);

        return { x: col * w * 0.75, y: row * h + rowOffset };

    } else if (state.gridType === 'hex-h') {

        /* Hexagonais de pointy-top (horizontal) */

        const h   = gs;

        const w   = gs * Math.sqrt(3) / 2;

        const row = Math.round(rawY / (h * 0.75));

        const colOffset = (row % 2 === 0) ? 0 : w / 2;

        const col = Math.round((rawX - colOffset) / w);

        return { x: col * w + colOffset, y: row * h * 0.75 };

    }

    /* Quadrado — snap convencional */

    return { x: snapToGrid(rawX), y: snapToGrid(rawY) };

}

function cellKey(c, r) { return `${c},${r}`; }

function mapCoords(cx, cy) {

    const r = container.getBoundingClientRect();

    return { x: (cx - r.left) / state.zoom, y: (cy - r.top) / state.zoom };

}

/* ═══════════════════════════════════════════════════════════════

   ─── Grade Híbrida ───

═══════════════════════════════════════════════════════════════ */

/**

 * Alterna entre 'square', 'hex-v' e 'hex-h'.

 * Salva no Firestore para todos os jogadores.

 */

window.toggleGridType = async (type) => {

    state.gridType = type;

    applyGridTypeUI(type);

    renderMap();

    try {

        const { db, appId, doc, setDoc } = window.vtt;

        await setDoc(

            doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'),

            { gridType: type }, { merge: true }

        );

    } catch (e) { console.error('[VTT] Erro ao salvar tipo de grade:', e); }

};

/** Atualiza classes e label da UI conforme o tipo de grade */

function applyGridTypeUI(type) {

    ['square', 'hex-v', 'hex-h'].forEach(t => {

        _el('btn-grid-' + t)?.classList.remove('active');

    });

    _el('btn-grid-' + type)?.classList.add('active');

    const labels = { square: 'Quadrado', 'hex-v': 'Hex Vertical', 'hex-h': 'Hex Horizontal' };

    const lbl = _el('grid-type-label');

    if (lbl) lbl.innerText = labels[type] || type;

    if (type === 'square') {

        gridOverlay.classList.remove('hex-mode');

        hexCanvas.style.display = 'none';

    } else {

        gridOverlay.classList.add('hex-mode');

        hexCanvas.style.display = 'block';

    }

}

/**

 * Desenha a grade hexagonal em canvas.

 */

function drawHexGrid() {

    const { mapWidth, mapHeight, gridSize, opacity, gridType } = state;

    hexCanvas.width  = mapWidth;

    hexCanvas.height = mapHeight;

    hexCtx.clearRect(0, 0, mapWidth, mapHeight);

    hexCtx.strokeStyle = `rgba(0,0,0,${Math.min(1, opacity * 2)})`;

    hexCtx.lineWidth = 1;

    if (gridType === 'hex-v') {

        /* Flat-top hexagons — grade vertical */

        const w  = gridSize;

        const h  = gridSize * Math.sqrt(3) / 2;

        const cols = Math.ceil(mapWidth  / (w * 0.75)) + 2;

        const rows = Math.ceil(mapHeight / h) + 2;

        for (let col = -1; col < cols; col++) {

            for (let row = -1; row < rows; row++) {

                const cx = col * w * 0.75;

                const cy = row * h + (col % 2 === 0 ? 0 : h / 2);

                drawFlatHex(cx, cy, gridSize / 2);

            }

        }

    } else if (gridType === 'hex-h') {

        /* Pointy-top hexagons — grade horizontal */

        const h   = gridSize;

        const w   = gridSize * Math.sqrt(3) / 2;

        const cols = Math.ceil(mapWidth  / w) + 2;

        const rows = Math.ceil(mapHeight / (h * 0.75)) + 2;

        for (let row = -1; row < rows; row++) {

            for (let col = -1; col < cols; col++) {

                const cx = col * w + (row % 2 === 0 ? 0 : w / 2);

                const cy = row * h * 0.75;

                drawPointyHex(cx, cy, gridSize / 2);

            }

        }

    }

}

function drawFlatHex(cx, cy, r) {

    hexCtx.beginPath();

    for (let i = 0; i < 6; i++) {

        const angle = (Math.PI / 180) * (60 * i);

        const x = cx + r * Math.cos(angle);

        const y = cy + r * Math.sin(angle);

        i === 0 ? hexCtx.moveTo(x, y) : hexCtx.lineTo(x, y);

    }

    hexCtx.closePath();

    hexCtx.stroke();

}

function drawPointyHex(cx, cy, r) {

    hexCtx.beginPath();

    for (let i = 0; i < 6; i++) {

        const angle = (Math.PI / 180) * (60 * i + 30);

        const x = cx + r * Math.cos(angle);

        const y = cy + r * Math.sin(angle);

        i === 0 ? hexCtx.moveTo(x, y) : hexCtx.lineTo(x, y);

    }

    hexCtx.closePath();

    hexCtx.stroke();

}

/* ═══════════════════════════════════════════════════════════════

   ─── Render Principal ───

═══════════════════════════════════════════════════════════════ */

function renderMap() {

    container.style.width     = state.mapWidth  + 'px';

    container.style.height    = state.mapHeight + 'px';

    container.style.transform = `translate(${state.pan.x}px,${state.pan.y}px) scale(${state.zoom})`;



    /* Grade quadrada via CSS background-size */

    gridOverlay.style.width  = state.mapWidth  + 'px';

    gridOverlay.style.height = state.mapHeight + 'px';

    gridOverlay.style.backgroundSize = `${state.gridSize}px ${state.gridSize}px`;

    gridOverlay.style.opacity        = state.opacity;



    /* Grade hexagonal via Canvas */

    if (state.gridType !== 'square') {

        drawHexGrid();

    }

    /* Redimensiona canvas sem limpar desnecessariamente */

    if (fogCanvas.width !== state.mapWidth || fogCanvas.height !== state.mapHeight) {

        fogCanvas.width  = state.mapWidth;

        fogCanvas.height = state.mapHeight;

    }

    if (rulerCanvas.width !== state.mapWidth || rulerCanvas.height !== state.mapHeight) {

        rulerCanvas.width  = state.mapWidth;

        rulerCanvas.height = state.mapHeight;

    }

    renderFog();

    renderRuler();

    updateTokenSizes();



    /* Atualiza inputs da sidebar */

    const g  = _el('grid-txt');

    if (g)  g.innerText = state.gridSize + 'px';

    const o  = _el('opacity-txt');

    if (o)  o.innerText = Math.round(state.opacity * 100) + '%';

    const or = _el('opacity-range');

    if (or) or.value = state.opacity * 100;

    const gr = _el('grid-range');    if (gr) gr.value = state.gridSize;

    const mw = _el('map-w-txt');

    if (mw) mw.innerText = state.mapWidth  + 'px';

    const mh = _el('map-h-txt');    if (mh) mh.innerText = state.mapHeight + 'px';



    /* Indicador de layer */

    const ln = _el('layer-num');

    if (ln) ln.innerText = state.activeLayer;

}

/* ═══════════════════════════════════════════════════════════════

   ─── Névoa de Guerra ───

═══════════════════════════════════════════════════════════════ */

function renderFog() {

    fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);

    if (!state.fogCells.size) return;

    /* Mestre vê névoa semi-transparente; jogador vê totalmente opaco */

    fogCtx.fillStyle = state.role === 'mestre' ? 'rgba(8,8,18,0.70)' : 'rgba(0,0,0,1.0)';

    state.fogCells.forEach(key => {

        const [c, r] = key.split(',').map(Number);

        fogCtx.fillRect(c * state.gridSize, r * state.gridSize, state.gridSize, state.gridSize);

    });

}

async function saveFogNow() {

    try {

        const { db, appId, doc, setDoc } = window.vtt;

        await setDoc(

            doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'),

            { fog: [...state.fogCells] }, { merge: true }

        );

    } catch (e) { console.error('[VTT] Erro ao salvar névoa:', e); }

}

let fogTimer = null;

function saveFogDebounced() { clearTimeout(fogTimer); fogTimer = setTimeout(saveFogNow, 350); }

window.clearFog = async () => { state.fogCells.clear(); renderFog(); await saveFogNow(); showToast('☀️ Mapa inteiro revelado', 'info'); };



window.fillFog = async () => {

    const cols = Math.ceil(state.mapWidth  / state.gridSize);

    const rows = Math.ceil(state.mapHeight / state.gridSize);

    for (let c = 0; c < cols; c++)

        for (let r = 0; r < rows; r++)

            state.fogCells.add(cellKey(c, r));

    renderFog();

    await saveFogNow();

    showToast('🌑 Mapa inteiro coberto por névoa', 'info');

};

window.revealAllFog = window.clearFog;

window.coverAllFog = window.fillFog;

function fogCellFromClient(cx, cy) {

    const { x, y } = mapCoords(cx, cy);

    const c = Math.floor(x / state.gridSize);

    const r = Math.floor(y / state.gridSize);

    if (c < 0 || r < 0 || c * state.gridSize >= state.mapWidth || r * state.gridSize >= state.mapHeight) return null;

    return { c, r };

}

function applyFogCellRect(startClientX, startClientY, endClientX, endClientY) {

    const p1 = mapCoords(startClientX, startClientY);

    const p2 = mapCoords(endClientX, endClientY);

    const minX = Math.max(0, Math.min(p1.x, p2.x));

    const maxX = Math.min(state.mapWidth - 1, Math.max(p1.x, p2.x));

    const minY = Math.max(0, Math.min(p1.y, p2.y));

    const maxY = Math.min(state.mapHeight - 1, Math.max(p1.y, p2.y));

    if (minX > state.mapWidth || minY > state.mapHeight || maxX < 0 || maxY < 0) return 0;

    const c1 = Math.floor(minX / state.gridSize);

    const c2 = Math.floor(maxX / state.gridSize);

    const r1 = Math.floor(minY / state.gridSize);

    const r2 = Math.floor(maxY / state.gridSize);

    let changed = 0;

    for (let c = c1; c <= c2; c++) {

        for (let r = r1; r <= r2; r++) {

            const k = cellKey(c, r);

            if (state.mode === 'fog-box-paint') {

                if (!state.fogCells.has(k)) changed++;

                state.fogCells.add(k);

            } else {

                if (state.fogCells.has(k)) changed++;

                state.fogCells.delete(k);

            }

        }

    }

    renderFog();

    return changed;

}

function updateFogSelectionBox(cx, cy) {

    if (!state.fogDragStart) return;

    const dx = cx - state.fogDragStart.x;

    const dy = cy - state.fogDragStart.y;

    if (!state.fogDragMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) state.fogDragMoved = true;

    if (!state.fogDragMoved) return;

    const left = Math.min(state.fogDragStart.x, cx);

    const top = Math.min(state.fogDragStart.y, cy);

    const width = Math.abs(dx);

    const height = Math.abs(dy);

    const fogClass = state.mode === 'fog-box-paint' ? 'fog-area-paint' : 'fog-area-erase';

    selBox.className = fogClass;

    selBox.style.cssText = `display:block;left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;

}

function applyFogAt(cx, cy) {

    const cell = fogCellFromClient(cx, cy);

    if (!cell) return;

    const { c, r } = cell;

    const k = cellKey(c, r);

    if (state.mode === 'fog-paint' || state.mode === 'fog-box-paint') state.fogCells.add(k); else state.fogCells.delete(k);

    renderFog();

}

/* ═══════════════════════════════════════════════════════════════

   ─── Régua ───

═══════════════════════════════════════════════════════════════ */

function renderRuler() {

    rulerCtx.clearRect(0, 0, rulerCanvas.width, rulerCanvas.height);

    if (!state.ruler) return;

    const { x1, y1, x2, y2 } = state.ruler;

    const dist = Math.sqrt((x2-x1)**2 + (y2-y1)**2) / state.gridSize;



    rulerCtx.strokeStyle = '#f59e0b';

    rulerCtx.lineWidth = 2;

    rulerCtx.setLineDash([6, 4]);

    rulerCtx.beginPath(); rulerCtx.moveTo(x1, y1); rulerCtx.lineTo(x2, y2); rulerCtx.stroke();

    rulerCtx.setLineDash([]);



    const mx = (x1+x2)/2, my = (y1+y2)/2;

    const label = dist.toFixed(1) + ' células';

    rulerCtx.font = 'bold 12px Inter, sans-serif';

    const tw = rulerCtx.measureText(label).width;

    rulerCtx.fillStyle = 'rgba(0,0,0,0.7)';

    rulerCtx.beginPath();

    rulerCtx.roundRect(mx - tw/2 - 6, my - 10, tw + 12, 20, 6);

    rulerCtx.fill();

    rulerCtx.fillStyle = '#fbbf24';

    rulerCtx.textAlign = 'center';

    rulerCtx.textBaseline = 'middle';

    rulerCtx.fillText(label, mx, my);

}

/* ═══════════════════════════════════════════════════════════════

   ─── Sistema de Camadas (Layers) ───

═══════════════════════════════════════════════════════════════ */

window.setLayer = async (layer) => {

    state.activeLayer = layer;

    /* Atualiza botões */

    [0,1,2].forEach(i => {

        _el('btn-layer-' + i)?.classList.toggle('active', i === layer);

    });

    /* Atualiza visibilidade de tokens por layer */

    updateLayerVisibility();



    /* Aplica mapa da respectiva layer */

    applyMapForCurrentLayer();

    try {

        const { db, appId, doc, setDoc } = window.vtt;

        await setDoc(

            doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'),

            { activeLayer: layer }, { merge: true }

        );

        showToast(`🏗️ Camada ${layer} ativa`, 'info');

    } catch (e) { console.error('[VTT] Erro ao salvar layer:', e); }

};

/**

 * Mostra/oculta wrappers de token com base na camada ativa.

 * Jogadores não veem tokens de outras camadas.

 * O Mestre vê mas com opacidade reduzida.

 */

function updateLayerVisibility() {

    document.querySelectorAll('.token-wrapper').forEach(wrapper => {

        const tokenLayer = parseInt(wrapper.dataset.layer || '0');

        const isMestre   = state.role === 'mestre';

        if (tokenLayer === state.activeLayer) {

            wrapper.style.opacity = '1';

            wrapper.style.pointerEvents = 'auto';

        } else if (isMestre) {

            wrapper.style.opacity = '0.25';

            wrapper.style.pointerEvents = 'none';

        } else {

            wrapper.style.opacity = '0';

            wrapper.style.pointerEvents = 'none';

        }

    });

}

/* ═══════════════════════════════════════════════════════════════

   ─── Condições / Status ───

═══════════════════════════════════════════════════════════════ */

const STATUS_CONDITIONS = [

    { id: 'blinded',    emoji: '🙈', label: 'Cego',         bg: '#1e293b' },

    { id: 'charmed',    emoji: '💕', label: 'Encantado',    bg: '#831843' },

    { id: 'frightened', emoji: '😨', label: 'Amedrontado',  bg: '#7c3aed' },

    { id: 'grappled',   emoji: '🤼', label: 'Agarrado',     bg: '#92400e' },

    { id: 'incapac',    emoji: '😵', label: 'Incapacitado', bg: '#111827' },

    { id: 'invisible',  emoji: '👻', label: 'Invisível',    bg: '#1e293b' },

    { id: 'paralyzed',  emoji: '⚡', label: 'Paralisado',   bg: '#1d4ed8' },

    { id: 'petrified',  emoji: '🗿', label: 'Petrificado',  bg: '#374151' },

    { id: 'poisoned',   emoji: '☠️', label: 'Envenenado',   bg: '#166534' },

    { id: 'prone',      emoji: '🤕', label: 'Caído',        bg: '#7f1d1d' },

    { id: 'restrained', emoji: '🔗', label: 'Restringido',  bg: '#78350f' },

    { id: 'stunned',    emoji: '💫', label: 'Atordoado',    bg: '#4a044e' },

    { id: 'exhausted',  emoji: '💤', label: 'Exausto',      bg: '#0f172a' },

    { id: 'dodging',    emoji: '🛡️', label: 'Esquivando',   bg: '#0c4a6e' },

    { id: 'raging',     emoji: '🔥', label: 'Enraivecido',  bg: '#7f1d1d' },

    { id: 'blessed',    emoji: '✨', label: 'Abençoado',    bg: '#713f12' },

];

let statusTokenId = null;

function openStatusModal(id) {

    statusTokenId = id;

    const currentConditions = tokenDataMap[id]?.conditions || [];

    const grid = _el('status-grid');

    grid.innerHTML = '';

    STATUS_CONDITIONS.forEach(cond => {

        const active = currentConditions.includes(cond.id);

        const btn = document.createElement('button');

        btn.title = cond.label;

        btn.style.cssText = `

            padding: 6px; border-radius: 10px; border: 2px solid transparent;

            background: ${active ? cond.bg : 'rgba(30,41,59,0.5)'};

            cursor: pointer; display: flex; flex-direction: column;

            align-items: center; gap: 2px; transition: all 0.15s;

            border-color: ${active ? '#5C6BC0' : 'rgba(255,255,255,0.08)'};

        `;

        btn.innerHTML = `<span style="font-size:16px">${cond.emoji}</span><span style="font-size:7px;color:#94a3b8;font-weight:700">${cond.label}</span>`;

        btn.onclick = () => toggleCondition(id, cond.id, btn, cond);

        grid.appendChild(btn);

    });

    _el('status-modal').classList.add('open');

}

async function toggleCondition(id, condId, btn, condDef) {

    const current = [...(tokenDataMap[id]?.conditions || [])];

    const idx = current.indexOf(condId);

    if (idx >= 0) {

        current.splice(idx, 1);

        btn.style.background = 'rgba(30,41,59,0.5)';

        btn.style.borderColor = 'rgba(255,255,255,0.08)';

    } else {

        current.push(condId);

        btn.style.background = condDef.bg;

        btn.style.borderColor = '#5C6BC0';

    }

    if (tokenDataMap[id]) tokenDataMap[id].conditions = current;

    try {

        const { db, appId, updateDoc, doc } = window.vtt;

        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tokens', id), { conditions: current });

    } catch (e) { console.error('[VTT] Erro ao salvar condição:', e); }

}

_el('status-close').onclick = () => { _el('status-modal').classList.remove('open'); statusTokenId = null; };

/* ═══════════════════════════════════════════════════════════════

   ─── Tokens DOM ───

═══════════════════════════════════════════════════════════════ */

function tokenPixelSize(tokenSize) {

    return state.gridSize * tokenSize - 4;

}

function tokenVisualCenterOffset(tokenSize) {

    return tokenPixelSize(tokenSize) / 2;

}

function snapTokenDropPosition(left, top, tokenSize) {

    const centerOffset = tokenVisualCenterOffset(tokenSize);

    const rawX = left + centerOffset - (state.gridSize * tokenSize) / 2;

    const rawY = top + centerOffset - (state.gridSize * tokenSize) / 2;

    return snapHex(rawX, rawY);

}

function updateTokenSizes() {

    document.querySelectorAll('.token').forEach(el => {

        const ts = parseFloat(el.dataset.tokenSize || '1');

        const px = tokenPixelSize(ts);

        el.style.width = el.style.height = px + 'px';

        const wrapper = el.closest('.token-wrapper');

        if (wrapper) wrapper.style.width = wrapper.style.height = px + 'px';

    });

}

function updateTokenDOM(id, data) {

    const wrapperId = 'tw-' + id;

    let wrapper = _el(wrapperId);

    let el;

    const tokenSize = data.tokenSize || 1;

    const layer     = data.layer     || 0;

    if (!wrapper) {

        wrapper = document.createElement('div');

        wrapper.id = wrapperId;

        wrapper.className = 'token-wrapper';

        el = document.createElement('div');

        el.id = id;

        el.className = 'token';

        el.dataset.tokenSize = tokenSize;

        el.style.backgroundImage = `url(${data.url})`;

        el.setAttribute('role', 'img');

        el.setAttribute('aria-label', data.name || 'Token');

        /* ── Container de barras de recurso (HP + Mana) ── */

        const barsContainer = document.createElement('div');

        barsContainer.className = 'token-bars-container';

        barsContainer.id = 'bars-' + id;

        /* Barra de HP */

        const hpBar  = document.createElement('div');

        hpBar.className = 'token-resource-bar'; hpBar.id = 'hp-bar-' + id;

        const hpFill = document.createElement('div');

        hpFill.className = 'token-resource-fill token-hp-fill';

        hpFill.id = 'hp-fill-' + id;

        const hpVal  = document.createElement('span');

        hpVal.className = 'token-bar-value'; hpVal.id = 'hp-val-' + id;

        hpBar.appendChild(hpFill); hpBar.appendChild(hpVal);

        /* Barra de Mana */

        const manaBar  = document.createElement('div');

        manaBar.className = 'token-resource-bar'; manaBar.id = 'mana-bar-' + id;

        const manaFill = document.createElement('div');

        manaFill.className = 'token-resource-fill token-mana-fill';

        manaFill.id = 'mana-fill-' + id;

        const manaVal  = document.createElement('span');

        manaVal.className = 'token-bar-value'; manaVal.id = 'mana-val-' + id;

        manaBar.appendChild(manaFill); manaBar.appendChild(manaVal);

        barsContainer.appendChild(hpBar);

        barsContainer.appendChild(manaBar);

        wrapper.appendChild(el);

        /* Info abaixo do token (nome + barras) — fora do círculo */

        const infoContainer = document.createElement('div');

        infoContainer.className = 'token-info';

        infoContainer.id = 'info-' + id;

        /* Nome */

        const nameEl = document.createElement('div');

        nameEl.className = 'token-name'; nameEl.id = 'name-' + id;

        infoContainer.appendChild(nameEl);

        infoContainer.appendChild(barsContainer);

        wrapper.appendChild(infoContainer);

        /* Badge de controle do jogador */

        const badge = document.createElement('div');

        badge.className = 'token-player-badge'; badge.id = 'badge-' + id;

        badge.title = 'Jogadores podem controlar';

        wrapper.appendChild(badge);

        /* Ícones de Status */

        const statusRing = document.createElement('div');

        statusRing.className = 'token-status-ring'; statusRing.id = 'status-ring-' + id;

        wrapper.appendChild(statusRing);

        attachTokenEvents(el, id);

        _el('tokens-layer').appendChild(wrapper);

    } else {

        el = _el(id);

        el.dataset.tokenSize = tokenSize;

    }

    /* Salva dados locais */

    tokenDataMap[id] = {

        playerControlled: !!data.playerControlled,

        conditions: data.conditions || [],

        layer: layer,

        name:    data.name    ?? null,

        hp:      data.hp      ?? null,

        maxHp:   data.maxHp   ?? null,

        mana:    data.mana    ?? null,

        maxMana: data.maxMana ?? null

    };

    wrapper.dataset.layer = layer;

    /* Posição */

    const posX = (data.x || 0) + 2;

    const posY = (data.y || 0) + 2;

    wrapper.style.left = posX + 'px';

    wrapper.style.top  = posY + 'px';

    const px = tokenPixelSize(tokenSize);

    el.style.width = el.style.height = px + 'px';

    wrapper.style.width = wrapper.style.height = px + 'px';

    el.style.borderColor = data.color || '#ffffff';

    /* Badge e cursor */

    const badge = _el('badge-' + id);

    const ctrl = data.controlledBy ?? (data.playerControlled ? 'all' : 'gm');

    const playerCanMove = canControlToken(id);

    if (badge) {

        const isGmOnly = !ctrl || ctrl === 'gm';

        badge.classList.toggle('visible', !isGmOnly);

        if (ctrl === 'all') {

            badge.textContent = '👥'; badge.title = 'Todos podem mover';

        } else if (!isGmOnly) {

            badge.textContent = '👤'; badge.title = 'Controle: ' + ctrl;

        }

    }

    el.classList.toggle('player-can-move', playerCanMove && state.role !== 'mestre');

    el.classList.toggle('locked', !playerCanMove && state.role !== 'mestre');

    /* ── Barras de HP ── */

    const hp = data.hp ?? null, maxHp = data.maxHp ?? null;

    const hpBar  = _el('hp-bar-'  + id);

    const hpFill = _el('hp-fill-' + id);

    const hpVal  = _el('hp-val-'  + id);

    if (hpBar && hpFill && hp !== null && maxHp !== null && maxHp > 0) {

        hpBar.style.display = 'block';

        const pct = Math.max(0, Math.min(1, hp / maxHp)) * 100;

        hpFill.style.width = pct + '%';

        /* Cor dinâmica: verde → amarelo → vermelho */

        hpFill.style.background = pct > 50

            ? `linear-gradient(90deg, #047857, #10B981)`

            : pct > 25

                ? `linear-gradient(90deg, #b45309, #f59e0b)`

                : `linear-gradient(90deg, #b91c1c, #ef4444)`;

        if (hpVal) hpVal.innerText = hp + '/' + maxHp;

    } else if (hpBar) {

        hpBar.style.display = 'none';

        if (hpVal) hpVal.innerText = '';

    }

    /* ── Barra de Mana ── */

    const mana = data.mana ?? null, maxMana = data.maxMana ?? null;

    const manaBar  = _el('mana-bar-'  + id);

    const manaFill = _el('mana-fill-' + id);

    const manaVal  = _el('mana-val-'  + id);

    if (manaBar && manaFill && mana !== null && maxMana !== null && maxMana > 0) {

        manaBar.style.display = 'block';

        const pct = Math.max(0, Math.min(1, mana / maxMana)) * 100;

        manaFill.style.width = pct + '%';

        if (manaVal) manaVal.innerText = mana + '/' + maxMana;

    } else if (manaBar) {

        manaBar.style.display = 'none';

        if (manaVal) manaVal.innerText = '';

    }

    /* Nome */

    const nameEl = _el('name-' + id);

    if (nameEl) {

        if (data.name) { nameEl.innerText = data.name;

        nameEl.style.display = 'block'; }

        else             { nameEl.style.display = 'none';

        }

        el.setAttribute('aria-label', data.name || 'Token');

    }

    /* Ícones de condições */

    renderStatusIcons(id, data.conditions || []);

    /* Visibilidade por layer */

    updateLayerVisibility();

}

/** Renderiza ícones de condições ao redor do token */

function renderStatusIcons(id, conditions) {

    const ring = _el('status-ring-' + id);

    if (!ring) return;

    ring.innerHTML = '';

    conditions.forEach(condId => {

        const def = STATUS_CONDITIONS.find(c => c.id === condId);

        if (!def) return;

        const icon = document.createElement('span');

        icon.className = 'status-icon';

        icon.style.background = def.bg;

        icon.title = def.label;

        icon.innerText = def.emoji;

        ring.appendChild(icon);

    });

}

/* ═══════════════════════════════════════════════════════════════

   ─── Eventos do Token ───

═══════════════════════════════════════════════════════════════ */

/* Returns true if the current user (player) can control this token */
function canControlToken(id) {
    if (state.role === 'mestre') return true;
    const data = tokenDataMap[id];
    if (!data) return false;
    const ctrl = data.controlledBy;
    if (ctrl === undefined) return !!data.playerControlled; /* backward compat */
    if (!ctrl || ctrl === 'gm') return false;
    if (ctrl === 'all') return true;
    return ctrl === state.playerName;
}

function attachTokenEvents(el, id) {

    el.addEventListener('mousedown', (e) => {

        if (e.button !== 0 || e.ctrlKey) return;

        if (state.mode !== 'move' && state.mode !== 'select') return;

        if (!canControlToken(id)) return;

        /* Bloqueia tokens de outras camadas para jogadores */

        const tokenLayer = tokenDataMap[id]?.layer ?? 0;

        if (tokenLayer !== state.activeLayer && state.role !== 'mestre') return;

        e.stopPropagation();

        /* Seleção: shift+click adiciona/remove do grupo, click simples troca */

        const alreadySelected = state.selectedTokenIds.has(id);

        if (state.mode === 'select') {

            if (e.shiftKey) {

                /* Shift+clique = adiciona/remove do grupo */

                if (alreadySelected) {

                    state.selectedTokenIds.delete(id);

                    el.parentElement.classList.remove('selected');

                } else {

                    state.selectedTokenIds.add(id);

                    el.parentElement.classList.add('selected');

                }

                return;

            }

            if (!alreadySelected) {

                /* Clique simples em token não selecionado → só seleciona esse */

                clearSelection();

                state.selectedTokenIds.add(id);

                el.parentElement.classList.add('selected');

                      /* No modo seleção, primeiro clique só seleciona.
                          Arraste só é permitido em token já selecionado. */
                      return;

            }

        } else {

            /* Modo mover: limpa seleção ao arrastar um token não selecionado */

            if (!alreadySelected) clearSelection();

        }

        /* Tokens a mover: selecionados (se houver) ou só este */

        const tokensToMove = state.selectedTokenIds.size > 0
            ? [...state.selectedTokenIds]
            : [id];

        /* Posições iniciais de todos os tokens do grupo */

        const startPos = {};

        tokensToMove.forEach(tid => {

            const w = _el('tw-' + tid);

            if (w) startPos[tid] = {

                x: parseFloat(w.style.left) || 0,

                y: parseFloat(w.style.top)  || 0

            };

        });

        el.style.transition = 'none';

        const sx = e.clientX, sy = e.clientY;

        let hasMoved = false;

        let dragStarted = false;

        const onMove = (ev) => {

            const dx = (ev.clientX - sx) / state.zoom;

            const dy = (ev.clientY - sy) / state.zoom;

            if (!dragStarted) {

                if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) return;

                dragStarted = true;

                hasMoved = true;

            }

            tokensToMove.forEach(tid => {

                const w = _el('tw-' + tid);

                if (w && startPos[tid]) {

                    w.style.left = (startPos[tid].x + dx) + 'px';

                    w.style.top  = (startPos[tid].y + dy) + 'px';

                }

            });

        };

        const onStop = async (ev) => {

            window.removeEventListener('mousemove', onMove);

            window.removeEventListener('mouseup', onStop);

            el.style.transition = '';

            if (!hasMoved) return;

            /* Snap e salvar cada token */

            const saves = tokensToMove.map(async (tid) => {

                const w = _el('tw-' + tid);

                if (!w || !startPos[tid]) return;

                const tokenEl = _el(tid);

                const size = parseFloat(tokenEl?.dataset.tokenSize || '1');

                /* Posição visual atual do wrapper (sem offset de borda) */

                const rawLeft = (parseFloat(w.style.left) || 0) - 2;

                const rawTop  = (parseFloat(w.style.top)  || 0) - 2;

                /* Centro do token em coordenadas de mapa */

                const halfSpan = (state.gridSize * size) / 2;

                const cx = rawLeft + halfSpan;

                const cy = rawTop  + halfSpan;

                /* Snap: encontra célula mais próxima ao centro do token */

                const snappedFinal = snapHex(

                    cx - halfSpan,

                    cy - halfSpan

                );

                w.style.left = (snappedFinal.x + 2) + 'px';

                w.style.top  = (snappedFinal.y + 2) + 'px';

                try {

                    const { db, appId, updateDoc, doc } = window.vtt;

                    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tokens', tid), { x: snappedFinal.x, y: snappedFinal.y });

                } catch (err) { console.error('[VTT] Erro ao mover token:', err); }

            });

            await Promise.all(saves);

            if (tokensToMove.length > 1) {

                showToast(`${tokensToMove.length} tokens movidos`, 'info');

            } else {

                showToast('Token movido', 'info');

            }

        };

        window.addEventListener('mousemove', onMove);

        window.addEventListener('mouseup', onStop);

    });

    el.addEventListener('contextmenu', (e) => {

        if (!canControlToken(id)) return;

        e.preventDefault(); e.stopPropagation();

        ctxTokenId = id;

        const isMestre = state.role === 'mestre';

        document.querySelectorAll('.ctx-gm-only').forEach(el => el.style.display = isMestre ? '' : 'none');

        if (isMestre) {

            const ctrl = tokenDataMap[id]?.controlledBy;
            const oldPC = tokenDataMap[id]?.playerControlled;
            let ctrlLabel = '🔒 Apenas Mestre';
            if (ctrl === 'all' || (ctrl === undefined && oldPC)) ctrlLabel = '👥 Todos';
            else if (ctrl && ctrl !== 'gm') ctrlLabel = '👤 ' + ctrl;
            _el('ctx-player-ctrl').innerHTML = '🎮 &nbsp;Controle: ' + ctrlLabel;

        }

        ctxMenu.style.display = 'block';

        ctxMenu.style.left = e.clientX + 'px';

        ctxMenu.style.top  = e.clientY + 'px';

        requestAnimationFrame(() => {

            const rect = ctxMenu.getBoundingClientRect();

            if (rect.right  > window.innerWidth)  ctxMenu.style.left = (e.clientX - rect.width) + 'px';

            if (rect.bottom > window.innerHeight)  ctxMenu.style.top  = (e.clientY - rect.height) + 'px';

        });

    });

}

/* ═══════════════════════════════════════════════════════════════

   ─── Context Menu ───

═══════════════════════════════════════════════════════════════ */

document.addEventListener('click',       (e) => { if (!e.target.closest('#ctx-menu')) closeCtxMenu(); });

document.addEventListener('contextmenu', (e) => { if (!e.target.closest('#ctx-menu') && !e.target.closest('.token')) closeCtxMenu(); });

function closeCtxMenu() { ctxMenu.style.display = 'none'; ctxTokenId = null; }

_el('ctx-rename').onclick = () => { const id = ctxTokenId; if (!id) return; closeCtxMenu(); openRenameModal(id); };

_el('ctx-hp').onclick     = () => { const id = ctxTokenId; if (!id) return; closeCtxMenu(); openHpModal(id); };

_el('ctx-status').onclick = () => { const id = ctxTokenId; if (!id) return; closeCtxMenu(); openStatusModal(id); };

/* Alterar tamanho via menu contextual */

_el('ctx-resize-token').onclick = () => {

    const id = ctxTokenId;

    if (!id) return;

    closeCtxMenu();

    openResizeTokenModal(id);

};

const colorMap = {

    'ctx-color-w': '#ffffff',

    'ctx-color-r': '#ef4444',

    'ctx-color-g': '#10B981',

    'ctx-color-b': '#3b82f6',

    'ctx-color-y': '#f59e0b'

};



Object.keys(colorMap).forEach(cid => {

    _el(cid).onclick = async () => {

        const id = ctxTokenId; if (!id) return;

        closeCtxMenu();

        try {

            const { db, appId, updateDoc, doc } = window.vtt;

            await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tokens', id), { color: colorMap[cid] });

        } catch (e) { console.error('[VTT] Erro ao alterar cor:', e); }

    };

});

_el('ctx-delete').onclick = async () => {

    const id = ctxTokenId; if (!id) return;

    closeCtxMenu();

    try {

        const { db, appId, deleteDoc, doc } = window.vtt;

        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tokens', id));

        showToast('🗑️ Token removido', 'warn');

    } catch (e) { console.error('[VTT] Erro ao deletar token:', e); showToast('Erro ao deletar', 'error'); }

};

_el('ctx-player-ctrl').onclick = () => {

    const id = ctxTokenId;

    if (!id) return;

    closeCtxMenu();

    openControlModal(id);

};

/* ── Control Permission Modal ── */

let controlModalTokenId = null;

window.openControlModal = function (id) {

    controlModalTokenId = id;

    const optionsEl = _el('ctrl-perm-options');

    optionsEl.innerHTML = '';

    const current = tokenDataMap[id]?.controlledBy
        ?? (tokenDataMap[id]?.playerControlled ? 'all' : 'gm');

    const addOption = (value, label, desc) => {

        const btn = document.createElement('button');

        btn.className = 'ctrl-perm-btn' + (current === value ? ' active' : '');

        btn.innerHTML = '<span class="ctrl-perm-label">' + label + '</span>'
            + (desc ? '<span class="ctrl-perm-desc">' + desc + '</span>' : '');

        btn.onclick = () => applyControlPermission(id, value);

        optionsEl.appendChild(btn);

    };

    addOption('gm',  '🔒 Apenas Mestre', 'Somente o Mestre pode mover');

    addOption('all', '👥 Todos os Jogadores', 'Qualquer jogador pode mover');

    /* Add one button per connected player */

    const jogadores = presenceUsers.filter(u => u.role !== 'mestre');

    jogadores.forEach(u => {

        addOption(u.name, '👤 ' + u.name, 'Somente este jogador pode mover');

    });

    _el('control-permission-modal').classList.add('open');

};

window.closeControlModal = function () {

    _el('control-permission-modal').classList.remove('open');

    controlModalTokenId = null;

};

async function applyControlPermission(id, value) {

    window.closeControlModal();

    try {

        const { db, appId, updateDoc, doc } = window.vtt;

        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tokens', id), {

            controlledBy: value,

            playerControlled: value !== 'gm', /* keep old field in sync for compat */

        });

        const labels = { gm: 'Apenas Mestre', all: 'Todos os Jogadores' };

        showToast('🎮 Controle: ' + (labels[value] || value), 'info');

    } catch (e) { console.error('[VTT] Erro ao definir controle:', e); showToast('Erro ao salvar', 'error'); }

};

/* ═══════════════════════════════════════════════════════════════

   ─── Resize Token Modal (alterar tamanho de token existente) ───

═══════════════════════════════════════════════════════════════ */

let resizeTargetId = null;

window.openResizeTokenModal = (id) => {

    resizeTargetId = id;

    _el('resize-token-modal').classList.add('open');

};

window.closeResizeTokenModal = () => {

    _el('resize-token-modal').classList.remove('open');

    resizeTargetId = null;

};

window.applyTokenResize = async (size) => {

    const id = resizeTargetId; if (!id) return;

    _el('resize-token-modal').classList.remove('open');

    resizeTargetId = null;

    try {

        const { db, appId, updateDoc, doc } = window.vtt;

        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tokens', id), { tokenSize: size });

    } catch (e) { console.error('[VTT] Erro ao redimensionar token:', e); }

};

/* ═══════════════════════════════════════════════════════════════

   ─── HP + Mana Modal ───

═══════════════════════════════════════════════════════════════ */

let hpTokenId = null;

function openHpModal(id) {

    hpTokenId = id;

    /* Pré-preenche imediatamente com os valores do cache local */

    const cached = tokenDataMap[id] || {};

    _el('hp-current-input').value   = cached.hp      ?? '';

    _el('hp-max-input').value       = cached.maxHp   ?? '';

    _el('mana-current-input').value = cached.mana    ?? '';

    _el('mana-max-input').value     = cached.maxMana ?? '';

    _el('hp-modal').classList.add('open');

    setTimeout(() => _el('hp-current-input').focus(), 50);

}

_el('hp-cancel').onclick = () => { _el('hp-modal').classList.remove('open'); hpTokenId = null; };

_el('hp-save').onclick   = async () => {

    if (!hpTokenId) return;

    const hp     = parseInt(_el('hp-current-input').value);

    const maxHp  = parseInt(_el('hp-max-input').value);

    const mana   = parseInt(_el('mana-current-input').value);

    const maxMana= parseInt(_el('mana-max-input').value);

    _el('hp-modal').classList.remove('open');

    const upd = {};

    if (!isNaN(hp))    upd.hp    = hp;

    if (!isNaN(maxHp)) upd.maxHp = maxHp;

    if (!isNaN(mana))  upd.mana  = mana;

    if (!isNaN(maxMana)) upd.maxMana = maxMana;

    if (Object.keys(upd).length) {

        try {

            const { db, appId, updateDoc, doc } = window.vtt;

            await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tokens', hpTokenId), upd);

            showToast('❤️ HP / Mana salvos', 'success');

        } catch (e) { console.error('[VTT] Erro ao salvar HP/Mana:', e); showToast('Erro ao salvar HP', 'error'); }

    }

    hpTokenId = null;

};

_el('hp-modal').addEventListener('keydown', (e) => { if (e.key === 'Enter') _el('hp-save').click(); if (e.key === 'Escape') _el('hp-cancel').click(); });

/* ═══════════════════════════════════════════════════════════════

   ─── Rename Modal ───

═══════════════════════════════════════════════════════════════ */

let renameTokenId = null;

function openRenameModal(id) {

    renameTokenId = id;

    const n = _el('name-' + id);

    _el('rename-input').value = (n && n.innerText) || '';

    _el('rename-modal').classList.add('open');

    setTimeout(() => { _el('rename-input').focus(); _el('rename-input').select(); }, 50);

}

_el('rename-cancel').onclick = () => { _el('rename-modal').classList.remove('open'); renameTokenId = null; };

_el('rename-save').onclick   = async () => {

    if (!renameTokenId) return;

    const name = _el('rename-input').value.trim();

    _el('rename-modal').classList.remove('open');

    try {

        const { db, appId, updateDoc, doc } = window.vtt;

        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tokens', renameTokenId), { name });

        showToast('✏️ Token renomeado', 'success');

    } catch (e) { console.error('[VTT] Erro ao renomear:', e); showToast('Erro ao renomear', 'error'); }

    renameTokenId = null;

};

_el('rename-modal').addEventListener('keydown', (e) => { if (e.key === 'Enter') _el('rename-save').click(); if (e.key === 'Escape') _el('rename-cancel').click(); });

/* ═══════════════════════════════════════════════════════════════

   ─── Token Size Modal (novo token) ───

═══════════════════════════════════════════════════════════════ */

window.openTokenSizeModal  = () => _el('token-size-modal').classList.add('open');

window.closeTokenSizeModal = () => _el('token-size-modal').classList.remove('open');

window.selectTokenSize     = (size) => {

    state.pendingTokenSize = size;

    _el('token-size-modal').classList.remove('open');

    _el('f-token').click();

};

/* ═══════════════════════════════════════════════════════════════

   ─── Iniciativa (Setup e Painel Flutuante) ───

═══════════════════════════════════════════════════════════════ */

/* ─ Setup Modal ─ */

let initSetupEntries = [];

window.openInitSetupModal = () => {

    const list = _el('init-setup-list');

    list.innerHTML = '';

    initSetupEntries = [];



    // Se já houver iniciativa rodando, carrega os dados atuais para edição

    if (state.initiative.length > 0) {

        state.initiative.forEach(e => addInitSetupEntry(e.name, e.bonus, e.type));

    } else {

        addInitSetupEntry('', 0, 'PC');

        // Cria um vazio por padrão

    }

    _el('init-setup-modal').classList.add('open');

};

window.closeInitSetupModal = () => _el('init-setup-modal').classList.remove('open');

window.addInitSetupEntry = (name = '', bonus = 0, type = 'NPC') => {

    const id = Date.now() + Math.random();

    initSetupEntries.push({ id });

    const div = document.createElement('div');

    div.className = 'init-setup-row';

    div.id = 'setup-row-' + id;

    div.innerHTML = `

        <input type="text" class="init-setup-input init-setup-name name-input" placeholder="Nome" value="${name}">

        <input type="number" class="init-setup-input init-setup-bonus bonus-input" placeholder="Bônus" value="${bonus}">

        <select class="init-setup-input init-setup-type type-input">

            <option value="PC" ${type==='PC'?'selected':''}>Jogador</option>

            <option value="NPC" ${type==='NPC'?'selected':''}>NPC</option>

        </select>

        <button onclick="removeInitSetupEntry(${id})" class="init-setup-remove-btn">✕</button>

    `;

    _el('init-setup-list').appendChild(div);

};

window.removeInitSetupEntry = (id) => {

    initSetupEntries = initSetupEntries.filter(e => e.id !== id);

    _el('setup-row-' + id)?.remove();

};

window.rollAndStartInitiative = async () => {

    const rows = document.querySelectorAll('.init-setup-row');

    const rolledInitiative = [];

    rows.forEach(row => {

        const name = row.querySelector('.name-input').value.trim() || 'Desconhecido';

        const bonus = parseInt(row.querySelector('.bonus-input').value) || 0;

        const type = row.querySelector('.type-input').value;

        const roll = Math.floor(Math.random() * 20) + 1 + bonus; // 1d20 + bônus





            rolledInitiative.push({ id: Date.now() + Math.random(), name, bonus, type, roll });

        });

        // Ordena do maior pro menor

        rolledInitiative.sort((a, b) => b.roll - a.roll);

        closeInitSetupModal();

        try {

            const { db, appId, doc, setDoc } = window.vtt;

            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'), { 

                initiative: rolledInitiative, 

                initiativeTurn: 0,

                showTracker: true 

            }, { merge: true });

        } catch (e) { console.error('[VTT] Erro ao iniciar iniciativa:', e); }

    };

    /* ─ Painel Flutuante ─ */

    window.renderFloatingInitiative = () => {

        const panel = _el('floating-init-panel');

        const list = _el('floating-init-list');

        /* Auto-abre apenas quando o GM ativou o tracker via Firebase */
        if (state.showTracker && state.initiative.length > 0) {

            panel.style.display = 'flex';

        } else if (!panel.dataset.manualOpen && !state.showTracker) {

            panel.style.display = 'none';

        }

        /* Renderiza lista (ou estado vazio) */
        list.innerHTML = '';

        if (!state.initiative.length) {

            list.innerHTML = '<p style="text-align:center;padding:16px 8px;font-size:9px;color:#334155;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Sem iniciativa ativa</p>';

            return;

        }

        state.initiative.forEach((entry, idx) => {

            const isCurrent = idx === state.initiativeTurn;

            const typeClass = entry.type === 'PC' ? 'pc' : 'npc';

            const div = document.createElement('div');

            div.className = `init-entry ${isCurrent ? `active-turn ${typeClass}` : ''}`;

            div.innerHTML = `
                <div class="init-entry-main">
                    <span class="init-roll-badge">${entry.roll}</span>
                    <span class="init-name ${typeClass}">${entry.name} ${isCurrent ? '◀' : ''}</span>
                </div>
            `;

            list.appendChild(div);

        });

    };

    window.toggleFloatingInit = () => {

        const panel = _el('floating-init-panel');

        const isHidden = panel.style.display === 'none' || panel.style.display === '';

        panel.style.display = isHidden ? 'flex' : 'none';

        panel.dataset.manualOpen = isHidden ? '1' : '';

        if (isHidden) window.renderFloatingInitiative();

    };

    window.closeFloatingInit = async () => {

        try {

            const { db, appId, doc, setDoc } = window.vtt;

            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'), { showTracker: false }, { merge: true });

        } catch (e) { console.error('[VTT] Erro ao fechar iniciativa:', e); }

    };

    window.nextTurn = async () => {

        if (!state.initiative.length) return;

        const next = (state.initiativeTurn + 1) % state.initiative.length;

        try {

            const { db, appId, doc, setDoc } = window.vtt;

            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'), { initiativeTurn: next }, { merge: true });

        } catch (e) { console.error('[VTT] nextTurn:', e); }

    };

    window.prevTurn = async () => {

        if (!state.initiative.length) return;

        const prev = (state.initiativeTurn - 1 + state.initiative.length) % state.initiative.length;

        try {

            const { db, appId, doc, setDoc } = window.vtt;

            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'), { initiativeTurn: prev }, { merge: true });

        } catch (e) { console.error('[VTT] prevTurn:', e); }

    };

/* ─ Drag & Resize do Painel Flutuante ─ */

const floatPanel = _el('floating-init-panel');

const floatHeader = _el('floating-init-header');

const floatResizer = _el('floating-init-resizer');



let isDraggingInit = false, isResizingInit = false;

let dragStartX, dragStartY, panelStartX, panelStartY, panelStartW, panelStartH;

floatHeader.addEventListener('mousedown', (e) => {

    if (e.target.tagName === 'BUTTON') return;

    isDraggingInit = true;

    dragStartX = e.clientX; dragStartY = e.clientY;

    panelStartX = floatPanel.offsetLeft; panelStartY = floatPanel.offsetTop;

    document.body.style.userSelect = 'none';

});



floatResizer.addEventListener('mousedown', (e) => {

    isResizingInit = true;

    dragStartX = e.clientX; dragStartY = e.clientY;

    panelStartW = floatPanel.offsetWidth; panelStartH = floatPanel.offsetHeight;

    e.stopPropagation();

    document.body.style.userSelect = 'none';

});

window.addEventListener('mousemove', (e) => {

    if (isDraggingInit) {

        floatPanel.style.left = (panelStartX + e.clientX - dragStartX) + 'px';

        floatPanel.style.top = (panelStartY + e.clientY - dragStartY) + 'px';

        floatPanel.style.right = 'auto'; // Remove o right para o left funcionar livremente

    }

    if (isResizingInit) {



        floatPanel.style.width = Math.max(200, panelStartW + e.clientX - dragStartX) + 'px';

        floatPanel.style.height = Math.max(200, panelStartH + e.clientY - dragStartY) + 'px';

    }

});

window.addEventListener('mouseup', () => {

    isDraggingInit = false;

    isResizingInit = false;

    document.body.style.userSelect = '';

});

/* ═══════════════════════════════════════════════════════════════

   ─── Reset Geral & Undo ───

═══════════════════════════════════════════════════════════════ */

window.globalReset = async () => {

    if (!confirm("⚠️ Tem certeza que deseja apagar TUDO? (Mapas, Tokens, Névoa, Iniciativa, Histórico)")) return;

    const { db, appId, doc, getDoc, getDocs, collection, deleteDoc, setDoc } = window.vtt;

    try {

        // 1. Fazer backup do World

        const worldRef = doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current');

        const worldSnap = await getDoc(worldRef);

        const worldData = worldSnap.exists() ? worldSnap.data() : {};

        // 2. Fazer backup dos Tokens

        const tokensRef = collection(db, 'artifacts', appId, 'public', 'data', 'tokens');

        const tokensSnap = await getDocs(tokensRef);

        const tokensData = [];

        tokensSnap.forEach(t => tokensData.push({ id: t.id, data: t.data() }));

        // 3. Salvar na memória e mostrar o botão Desfazer

        state.backup = { world: worldData, tokens: tokensData };

        const undoBtn = _el('btn-undo-reset');

        if (undoBtn) undoBtn.style.display = 'block';

        // 4. Excluir todos os tokens do banco

        for (const t of tokensData) {

            await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tokens', t.id));

        }

        // 5. Resetar o World e limpar as imagens de todos os mapas

        await setDoc(worldRef, {

            maps: { 0: null, 1: null, 2: null }, // Limpa mapas de todos andares

            mapUrl: '',                          // Limpa legado

            fog: [],

            initiative: [],

            initiativeTurn: 0,

            showTracker: false,

            activeLayer: 0,

            ping: null

        }, { merge: true });

        // 6. Limpa o histórico de dados local e do Firebase

        await clearDiceHistory();

    } catch (err) {

        console.error('[VTT] Erro no Reset Geral:', err);

        alert("Ocorreu um erro ao realizar o reset.");

    }

};

window.undoReset = async () => {

    if (!state.backup) return;

    const { db, appId, doc, setDoc } = window.vtt;

    try {

        // 1. Restaurar o World

        const worldRef = doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current');

        await setDoc(worldRef, state.backup.world);

        // 2. Restaurar os Tokens

        for (const t of state.backup.tokens) {

            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tokens', t.id), t.data);

        }

        // 3. Ocultar o botão e limpar a memória local

        state.backup = null;

        const undoBtn = _el('btn-undo-reset');

        if (undoBtn) undoBtn.style.display = 'none';

    } catch (err) {

        console.error('[VTT] Erro no Undo:', err);

        alert("Ocorreu um erro ao desfazer o reset.");

    }

};

/* ═══════════════════════════════════════════════════════════════

   ─── Modo de Ferramenta ───

═══════════════════════════════════════════════════════════════ */

window.setMode = (mode) => {

    if (state.mode !== mode) clearSelection();

    state.mode = mode;

        ['move', 'player-move', 'ping', 'select', 'fog-paint', 'fog-erase', 'fog-box-paint', 'fog-box-erase'].forEach(m => _el('tool-' + m)?.classList.remove('active'));

    _el('tool-' + mode)?.classList.add('active');

        if (mode === 'move') _el('tool-player-move')?.classList.add('active');

    viewport.className = mode === 'fog-box-paint' ? 'fog-paint'
                       : mode === 'fog-box-erase' ? 'fog-erase'
                       : mode === 'select'    ? 'select-mode'
                           : mode === 'ping'      ? 'ping-mode'
                       : '';

};

/* ═══════════════════════════════════════════════════════════════

   ─── Menu Tamanho do Mapa (retrátil) ───

═══════════════════════════════════════════════════════════════ */

window.toggleMapSize = () => {

    const panel = _el('map-size-panel');

    const arrow = _el('map-size-arrow');

    const btn   = document.querySelector('.collapse-btn');

    const open  = panel.classList.toggle('open');

    arrow.innerText = open ?

    '▾' : '▸';

    if (btn) btn.setAttribute('aria-expanded', open);

};

/* ═══════════════════════════════════════════════════════════════

   ─── Ping ───

═══════════════════════════════════════════════════════════════ */

const shownPings = new Set();

function showPing(x, y) {

    const key = `${Math.round(x)},${Math.round(y)},${Math.floor(Date.now() / 2500)}`;

    if (shownPings.has(key)) return;

    shownPings.add(key);

    const dot = document.createElement('div');

    dot.className = 'ping-dot';

    dot.style.left = x + 'px'; dot.style.top = y + 'px';

    container.appendChild(dot);

    setTimeout(() => dot.remove(), 2600);

    setTimeout(() => shownPings.delete(key), 5000);

}

async function sendPing(x, y) {

    showPing(x, y);

    try {

        const { db, appId, doc, setDoc } = window.vtt;

        await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'), { ping: { x, y, ts: Date.now() } }, { merge: true });

    } catch (e) { console.error('[VTT] sendPing:', e); }

}

/* ═══════════════════════════════════════════════════════════════

   ─── Câmera ───

═══════════════════════════════════════════════════════════════ */

window.syncCamera = async () => {

    try {

        const { db, appId, doc, setDoc } = window.vtt;

        await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'),

            { camera: { zoom: state.zoom, pan: { x: state.pan.x, y: state.pan.y } } }, { merge: true });

        showToast('📡 Visão sincronizada', 'success');

    } catch (e) { console.error('[VTT] syncCamera:', e); showToast('Erro ao sincronizar', 'error'); }

};

/* ═══════════════════════════════════════════════════════════════

   ─── Tamanho do Mapa ───

═══════════════════════════════════════════════════════════════ */

let resizeTimer = null;

window.resizeMap = (dim, delta) => {

    if (dim === 'width')  state.mapWidth  = Math.max(200, state.mapWidth  + delta);

    else                   state.mapHeight = Math.max(200, state.mapHeight + delta);

    renderMap();

    clearTimeout(resizeTimer);

    resizeTimer = setTimeout(async () => {

        try {

            const newMaps = { ...state.maps };

            if (!newMaps[state.activeLayer]) newMaps[state.activeLayer] = { url: '', width: 1200, height: 800 };

            newMaps[state.activeLayer].width = state.mapWidth;

            newMaps[state.activeLayer].height = state.mapHeight;

            const { db, appId, doc, setDoc } = window.vtt;

            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'),

                { maps: newMaps }, { merge: true });

        } catch (e) { console.error('[VTT] resizeMap:', e); }

    }, 400);

};

_el('row-width').addEventListener('wheel',  (e) => { e.preventDefault(); e.stopPropagation(); resizeMap('width',  e.deltaY < 0 ? 50 : -50); }, { passive: false });

_el('row-height').addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); resizeMap('height', e.deltaY < 0 ? 50 : -50); }, { passive: false });



/* ═══════════════════════════════════════════════════════════════

   ─── Grid / Opacidade ─── (salvam com debounce para performance)

═══════════════════════════════════════════════════════════════ */

let gridSaveTimer = null;

_el('grid-range').oninput = (e) => {

    state.gridSize = parseInt(e.target.value);

    renderMap();

    clearTimeout(gridSaveTimer);

    gridSaveTimer = setTimeout(async () => {

        try {

            const { db, appId, doc, setDoc } = window.vtt;

            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'), { grid: state.gridSize }, { merge: true });

        } catch (e) { console.error('[VTT] grid save:', e); }



     }, 300);

};

let opacSaveTimer = null;

_el('opacity-range').oninput = (e) => {

    state.opacity = parseFloat(e.target.value) / 100;

    renderMap();

    clearTimeout(opacSaveTimer);

    opacSaveTimer = setTimeout(async () => {

        try {

            const { db, appId, doc, setDoc } = window.vtt;

            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'), { opacity: state.opacity }, { merge: true });

        } catch (e) { console.error('[VTT] opacity save:', e); }



     }, 300);

};

/* ═══════════════════════════════════════════════════════════════

   ─── Upload Mapa ───

   Middleware de imagem: prioriza WebP;

   lazy load por quadrante se > 4096px

═══════════════════════════════════════════════════════════════ */

_el('f-map').onchange = (e) => {

    const file = e.target.files[0];

    if (!file) return;

    /* Suporte a vídeo WebM para mapas animados */

    if (file.type === 'video/webm') {

        const url = URL.createObjectURL(file);

        mapImg.src = url;

        mapImg.style.display = 'block';

        e.target.value = '';

        return;

    }

    const img = new Image(), reader = new FileReader();

    reader.onload = (ev) => {

        img.src = ev.target.result;

        img.onload = async () => {

            const canvas = document.createElement('canvas');

            const MAX = 2048;  /* limite aumentado para melhor qualidade */

            let w = img.width, h = img.height;



            /* Lazy loading por quadrantes se imagem for muito grande (>4096px) */

            if (w > 4096 || h > 4096) {

                console.warn('[VTT] Mapa muito grande – aplicando escala para performance.');

            }

            if (w > MAX || h > MAX) {

                const r = Math.min(MAX / w, MAX / h);

                w = Math.round(w * r);

                h = Math.round(h * r);

            }

            canvas.width = w;

            canvas.height = h;

            canvas.getContext('2d').drawImage(img, 0, 0, w, h);

            /* Tenta WebP primeiro (mais leve);

            fallback para JPEG */

            let url = canvas.toDataURL('image/webp', 0.85);

            if (!url.startsWith('data:image/webp')) {

                /* Browser não suporta WebP — usa JPEG */

                let q = 0.85;

                url = canvas.toDataURL('image/jpeg', q);

                while (url.length > 900000 && q > 0.2) { q -= 0.1; url = canvas.toDataURL('image/jpeg', q);

                }

            } else {

                /* Comprime WebP se ainda muito grande */

                let q = 0.85;

                while (url.length > 900000 && q > 0.2) { q -= 0.1; url = canvas.toDataURL('image/webp', q);

                }

            }

            state.mapWidth = w;

            state.mapHeight = h;

            try {

                const newMaps = { ...state.maps };

                newMaps[state.activeLayer] = { url: url, width: w, height: h };

                const { db, appId, doc, setDoc } = window.vtt;

                await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'),

                    { maps: newMaps }, { merge: true });

            } catch (err) { console.error('[VTT] Erro ao salvar mapa:', err);

            }

        };

    };

    reader.readAsDataURL(file);

    e.target.value = '';

};



/* ═══════════════════════════════════════════════════════════════

   ─── Upload Token ───

═══════════════════════════════════════════════════════════════ */

_el('f-token').onchange = (e) => {

    const file = e.target.files[0];

    if (!file) return;

    const tokenSize = state.pendingTokenSize || 1;

    const img = new Image(), reader = new FileReader();

    reader.onload = (ev) => {

        img.src = ev.target.result;

        img.onload = async () => {

            const canvas = document.createElement('canvas');

            canvas.width = canvas.height = 256;

            canvas.getContext('2d').drawImage(img, 0, 0, 256, 256);

            let url = canvas.toDataURL('image/webp', 0.82);

            if (!url.startsWith('data:image/webp')) {

                let q = 0.82;

                url = canvas.toDataURL('image/jpeg', q);

                while (url.length > 60000 && q > 0.2) { q -= 0.1; url = canvas.toDataURL('image/jpeg', q);

                }

            }

            try {

                const { db, appId, addDoc, collection } = window.vtt;

                await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tokens'), {

                    url, x: snapToGrid(120), y: snapToGrid(120),

                    name: '', color: '#ffffff', tokenSize,

                    layer: state.activeLayer,

                    controlledBy: state.role === 'mestre' ? 'gm' : state.playerName,

                    playerControlled: state.role !== 'mestre', /* legacy compat */

                    conditions: []

                });

            } catch (err) { console.error('[VTT] Erro ao criar token:', err);

            }

        };

    };

    reader.readAsDataURL(file);

    e.target.value = '';

    state.pendingTokenSize = 1;

};

/* ═══════════════════════════════════════════════════════════════

   ─── Parser de Dados Avançado ───

   Suporta: 2d20kh1 (keep high 1), 4d6d1 (drop lowest 1),

            2d20kl1 (keep low), 2d6dh1 (drop highest).

   Fórmula base: R = Σ(xi·dy) + k  para cada grupo de dados.

═══════════════════════════════════════════════════════════════ */

/**

 * Parseia e avalia uma notação de dados como "2d20kh1+5" ou "4d6d1+2d4".

 * @param {string} notation - String de notação de dados.

 * @returns {{ total: number, detail: string, groups: Array }}

 */

function parseAndRollNotation(notation) {

    const cleaned = notation.toLowerCase().replace(/\s/g, '');



    /* Regex para capturar cada componente:

     * (\d*)d(\d+)       → Nd{S} (N dados de S lados)

     * (?:kh(\d+))?

     * → keep high N

     * (?:kl(\d+))?

     * → keep low N

     * (?:dh(\d+))?

     * → drop high N

     * (?:(?:d(?!h))(\d+))?

     * → drop lowest N (sem letra 'h' depois)

     * ([+-]\d+)?

     * → bônus/penalidade

     */

    const groupRe = /(\d*)d(\d+)(?:kh(\d+))?(?:kl(\d+))?(?:dh(\d+))?(?:dl?(\d+))?([+-]\d+)?/g;



    let total = 0;

    const groups = [];

    let lastIndex = 0;

    let match;

    while ((match = groupRe.exec(cleaned)) !== null) {

        const n     = parseInt(match[1] || '1');

        /* quantidade de dados */

        const sides = parseInt(match[2]);

        /* lados do dado */

        const kh    = match[3] ?

        parseInt(match[3]) : null;  /* keep high */

        const kl    = match[4] ?

        parseInt(match[4]) : null;  /* keep low  */

        const dh    = match[5] ?

        parseInt(match[5]) : null;  /* drop high */

        const dl    = match[6] ?

        parseInt(match[6]) : null;  /* drop low  */

        const bonus = match[7] ?

        parseInt(match[7]) : 0;

        /* Rola todos os dados do grupo */

        const rolls = Array.from({ length: n }, () => Math.floor(Math.random() * sides) + 1);

        let kept = [...rolls].sort((a, b) => b - a);  /* ordena decrescente */

        /* Aplica modificadores de seleção */

        if (kh !== null) kept = kept.slice(0, kh);

        /* mantém os N maiores */

        else if (kl !== null) kept = kept.slice(-kl);

        /* mantém os N menores */

        else if (dh !== null) kept = kept.slice(dh);

        /* descarta os N maiores */

        else if (dl !== null) kept = kept.slice(0, kept.length - dl);

        /* descarta os N menores */

        const groupTotal = kept.reduce((a, b) => a + b, 0) + bonus;

        total += groupTotal;

        groups.push({ n, sides, rolls, kept, bonus, groupTotal });

    }

    /* Extrai bônus/penalidades standalone (ex: "+5" sem dados) */

    const standaloneBonus = cleaned.replace(groupRe, '').match(/[+-]\d+/g);

    if (standaloneBonus) {

        standaloneBonus.forEach(b => { total += parseInt(b); });

    }

    /* Monta detalhamento */

    const detail = groups.map(g => {

        const rollStr  = '[' + g.rolls.join(', ') + ']';

        const keptStr  = g.kept.length < g.rolls.length ? '→kept[' + g.kept.join(', ') + ']' : '';

        const bonusStr = g.bonus !== 0 ? (g.bonus > 0 ? '+' : '') + g.bonus 

        : '';

        return g.n + 'd' + g.sides + rollStr + keptStr + bonusStr + '=' + g.groupTotal;

    }).join(' + ');



    return { total, detail, groups };

}

window.rollNotation = async () => {

    const notation = (_el('dice-notation-input').value || '').trim();

    if (!notation) { _el('dice-notation-input').focus(); return; }

    try {

        const result = parseAndRollNotation(notation);

        const playerName = state.playerName || 'Jogador';

        const { db, appId, addDoc, collection } = window.vtt;

        await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'dice-rolls'), {

            playerName, notation, total: result.total,

            detail: result.detail, rolls: [], type: 0, count: 0, bonus: 0,

            ts: Date.now(), isCustom: true

        });

    } catch (e) { console.error('[VTT] Erro rollNotation:', e); }

};



/* ═══════════════════════════════════════════════════════════════

   ─── Dados (modo simples) ───

═══════════════════════════════════════════════════════════════ */

const diceState = { type: 20, count: 1, bonus: 0 };



function updateDicePreview() {

    const bonus    = diceState.bonus;

    const bonusStr = bonus > 0 ? '+' + bonus : bonus < 0 ? String(bonus) : '';

    const preview  = diceState.count + 'd' + diceState.type + bonusStr;

    const el = _el('dice-preview'); if (el) el.innerText = preview;

    const ct = _el('dice-count-txt'); if (ct) ct.innerText = diceState.count;

    const bt = _el('dice-bonus-txt');

    if (bt) { bt.innerText = bonus >= 0 ? '+' + bonus : String(bonus); bt.style.color = bonus < 0 ?

    '#f87171' : '#34d399'; }

}

window.setDiceType = (s) => {

    diceState.type = s;

    document.querySelectorAll('#dice-type-grid .dice-btn').forEach(b => b.classList.remove('active'));

    _el('dt-' + s)?.classList.add('active');

    updateDicePreview();

};

window.changeDiceCount = (delta) => { diceState.count = Math.max(1, Math.min(20, diceState.count + delta));

updateDicePreview(); };

window.changeDiceBonus = (delta) => { diceState.bonus += delta; updateDicePreview(); };



window.roll = async () => {

    const { type, count, bonus } = diceState;

    const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * type) + 1);

    const total = rolls.reduce((a, b) => a + b, 0) + bonus;

    const playerName = state.playerName ||

    (state.role === 'mestre' ? 'Mestre' : 'Jogador');

    try {

        const { db, appId, addDoc, collection } = window.vtt;

        await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'dice-rolls'), {

            playerName, type, count, bonus, rolls, total, ts: Date.now()

        });

    } catch (e) { console.error('[VTT] Erro ao salvar rolagem:', e); }

};



function renderDiceHistory(entries) {

    const hist = _el('dice-history'); if (!hist) return;

    hist.innerHTML = '';

    entries.forEach(d => {

        let formula, detail, totalColor, tag = '';

        if (d.isCustom) {

            /* Rolagem de notação personalizada */

            formula = d.notation || 'customizada';

            detail  = d.detail  || '';



            totalColor = '#a5b4fc';

            const entry = document.createElement('div');

            entry.style.cssText = `display:flex;justify-content:space-between;align-items:flex-start;background:rgba(99,102,241,0.07);border:1px solid rgba(99,102,241,0.15);padding:6px 8px;border-radius:8px;gap:6px;`;

            entry.innerHTML = `

                <div style="flex:1;min-width:0">



                    <div style="font-size:9px;font-weight:700;color:#64748b">${d.playerName} — <span style="color:#a5b4fc">${formula}</span></div>

                    <div style="font-size:7px;color:#475569;overflow:hidden;word-break:break-all">${detail}</div>

                </div>

                <span style="font-size:15px;font-weight:900;color:${totalColor};flex-shrink:0">${d.total}</span>



            `;

            hist.appendChild(entry);

            return;

        }

        const bonusStr  = d.bonus > 0 ?

        '+' + d.bonus : d.bonus < 0 ? String(d.bonus) : '';

        formula         = d.count + 'd' + d.type + bonusStr;

        const isCrit    = d.count === 1 && d.rolls[0] === d.type;

        const isFumble  = d.count === 1 && d.rolls[0] === 1;

        const bg        = isCrit ? 'rgba(34,197,94,0.08)' : isFumble ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.04)';

        const border    = isCrit ? 'rgba(34,197,94,0.2)'  : isFumble ? 'rgba(239,68,68,0.2)'  : 'rgba(255,255,255,0.05)';

        totalColor      = isCrit ? '#10B981' : isFumble ? '#ef4444' : '#a5b4fc';

        tag             = isCrit ?

        ' <span style="color:#10B981;font-weight:900">CRÍTICO!</span>'

                                  : isFumble ?

        ' <span style="color:#ef4444;font-weight:900">FALHA!</span>' : '';

        const entry = document.createElement('div');

        entry.style.cssText = `display:flex;justify-content:space-between;align-items:center;background:${bg};border:1px solid ${border};padding:6px 8px;border-radius:8px;gap:6px;`;

        entry.innerHTML = `

            <div style="flex:1;min-width:0">

                <div style="font-size:9px;font-weight:700;color:#64748b">${d.playerName} — <span style="color:#94a3b8">${formula}</span></div>

                <div style="font-size:8px;color:#475569;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">[${(d.rolls||[]).join(', ')}]${d.bonus !== 0 ?

        '<span style="color:'+(d.bonus>0?'#34d399':'#f87171')+'">'+(d.bonus>0?'+':'')+d.bonus+'</span>' : ''}${tag}</div>

            </div>

            <span style="font-size:15px;font-weight:900;color:${totalColor};flex-shrink:0">${d.total}</span>

        `;

        hist.appendChild(entry);

    });

}

/* ═══════════════════════════════════════════════════════════════

   ─── Eventos do Viewport ───

═══════════════════════════════════════════════════════════════ */

let isPanning = false;

const selBox = document.getElementById('selection-box');

viewport.addEventListener('mousedown', (e) => {

    if (e.button !== 0) return;

    /* Ctrl+Clique = Ping */

    if (e.ctrlKey) {

        e.preventDefault();

        const { x, y } = mapCoords(e.clientX, e.clientY);

        sendPing(x, y); return;

    }

    if (state.mode === 'ping') {

        e.preventDefault();

        const { x, y } = mapCoords(e.clientX, e.clientY);

        sendPing(x, y);

        setMode('move');

        return;

    }

    /* Shift+Clique = Régua */

    if (e.shiftKey) {

        e.preventDefault();

        const { x, y } = mapCoords(e.clientX, e.clientY);

        state.ruler = { x1: x, y1: y, x2: x, y2: y };

        state.isRulerActive = true; return;

    }

    /* ── Ferramentas de névoa célula-a-célula ── */

    if (state.mode === 'fog-paint' || state.mode === 'fog-erase') {

        if (state.role !== 'mestre') return;

        e.preventDefault();

        state.isFogPainting = true;

        applyFogAt(e.clientX, e.clientY);

        return;

    }

    if (state.mode === 'fog-box-paint' || state.mode === 'fog-box-erase') {

        if (state.role !== 'mestre') return;

        e.preventDefault();

        const boxMode = state.mode;

        state.fogDragStart = { x: e.clientX, y: e.clientY };

        state.fogDragMoved = false;

        selBox.style.display = 'none';

        selBox.className = '';

        const onMove = (ev) => updateFogSelectionBox(ev.clientX, ev.clientY);

        const onUp = async (ev) => {

            window.removeEventListener('mousemove', onMove);

            window.removeEventListener('mouseup', onUp);

            let count = 0;

            if (state.fogDragStart) count = applyFogCellRect(state.fogDragStart.x, state.fogDragStart.y, ev.clientX, ev.clientY);

            state.fogDragStart = null;

            state.fogDragMoved = false;

            selBox.style.display = 'none';

            selBox.className = '';

            if (count > 0) {

                await saveFogNow();

                showToast(`${count} célula${count > 1 ? 's' : ''} ${boxMode === 'fog-box-paint' ? 'escurecida' : 'revelada'}${count > 1 ? 's' : ''}`, 'info');

            }

        };

        window.addEventListener('mousemove', onMove);

        window.addEventListener('mouseup', onUp);

        return;

    }

    /* Fora de token, o viewport inteiro deve aceitar pan e ferramentas de fundo. */

    if (e.target.closest('.token-wrapper, .token')) return;

    /* ── Modo Select: seleção retangular no fundo ── */

    if (state.mode === 'select' && state.role === 'mestre') {

        const startX = e.clientX, startY = e.clientY;

        let isBox = false;

        selBox.style.display = 'none';

        const onMove = (ev) => {

            const dx = ev.clientX - startX, dy = ev.clientY - startY;

            if (!isBox && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) isBox = true;

            if (!isBox) return;

            const left   = Math.min(startX, ev.clientX);

            const top    = Math.min(startY, ev.clientY);

            const width  = Math.abs(dx);

            const height = Math.abs(dy);

            selBox.style.cssText = `display:block;left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;

        };

        const onUp = (ev) => {

            window.removeEventListener('mousemove', onMove);

            window.removeEventListener('mouseup',   onUp);

            selBox.style.display = 'none';

            if (!isBox) {

                /* Clique simples no fundo → limpa seleção */

                clearSelection(); return;

            }

            /* Determina rect da caixa */

            const boxLeft   = Math.min(startX, ev.clientX);

            const boxTop    = Math.min(startY, ev.clientY);

            const boxRight  = Math.max(startX, ev.clientX);

            const boxBottom = Math.max(startY, ev.clientY);

            /* Encontra tokens que intersectam a caixa */

            const wrappers = document.querySelectorAll('.token-wrapper');

            let count = 0;

            wrappers.forEach(w => {

                const r = w.getBoundingClientRect();

                const intersects = r.left < boxRight && r.right > boxLeft &&

                                   r.top  < boxBottom && r.bottom > boxTop;

                if (intersects) {

                    /* Extrai o ID do wrapper (formato tw-<id>) */

                    const wId = w.id.replace('tw-', '');

                    state.selectedTokenIds.add(wId);

                    w.classList.add('selected');

                    count++;

                }

            });

            if (count > 0) showToast(`${count} token${count > 1 ? 's' : ''} selecionado${count > 1 ? 's' : ''}`, 'info');

        };

        window.addEventListener('mousemove', onMove);

        window.addEventListener('mouseup',   onUp);

        return;

    }

    /* ── Modo Mover: pan + limpa seleção ── */

    clearSelection();

    isPanning = true;

    const sx = e.clientX - state.pan.x, sy = e.clientY - state.pan.y;

    const move = (ev) => { state.pan.x = ev.clientX - sx; state.pan.y = ev.clientY - sy; renderMap(); };

    window.addEventListener('mousemove', move);

    window.addEventListener('mouseup', () => { isPanning = false; window.removeEventListener('mousemove', move); }, { once: true });

});



window.addEventListener('mousemove', (e) => {

    if (state.isFogPainting) {

        if (state.mode === 'fog-box-paint' || state.mode === 'fog-box-erase') updateFogSelectionBox(e.clientX, e.clientY);

        else applyFogAt(e.clientX, e.clientY);

    }

    if (state.isRulerActive && state.ruler) {

        const { x, y } = mapCoords(e.clientX, e.clientY);

        state.ruler.x2 = x; state.ruler.y2 = y; renderRuler();

    }

});



window.addEventListener('mouseup', (e) => {

    if (state.isFogPainting) {

        if ((state.mode === 'fog-box-paint' || state.mode === 'fog-box-erase') && state.fogDragStart) {

            if (state.fogDragMoved) {

                const count = applyFogCellRect(state.fogDragStart.x, state.fogDragStart.y, e.clientX, e.clientY);

                if (count > 0) showToast(`${count} célula${count > 1 ? 's' : ''} ${state.mode === 'fog-box-paint' ? 'escurecida' : 'revelada'}${count > 1 ? 's' : ''}`, 'info');

            } else {

                applyFogAt(e.clientX, e.clientY);

            }

        }

        state.isFogPainting = false;

        state.fogDragStart = null;

        state.fogDragMoved = false;

        selBox.style.display = 'none';

        selBox.className = '';

        saveFogDebounced();

    }

    if (state.isRulerActive) {

        state.isRulerActive = false;

        setTimeout(() => { state.ruler = null; renderRuler(); }, 1500);

    }

});



viewport.addEventListener('wheel', (e) => {

    if (e.target.closest('.sidebar')) return;

    e.preventDefault();

    /* Zoom centrado na posição do cursor */

    const rect    = viewport.getBoundingClientRect();

    const mouseX  = e.clientX - rect.left;

    const mouseY  = e.clientY - rect.top;

    /* Ponto do mundo sob o cursor antes do zoom */

    const worldX  = (mouseX - state.pan.x) / state.zoom;

    const worldY  = (mouseY - state.pan.y) / state.zoom;

    /* Aplica o fator multiplicativo (mais suave que aditivo) */

    const factor  = e.deltaY > 0 ? 0.92 : 1.08;

    state.zoom    = Math.min(Math.max(state.zoom * factor, 0.1), 4);

    /* Reajusta pan para manter o ponto do mundo fixo sob o cursor */

    state.pan.x   = mouseX - worldX * state.zoom;

    state.pan.y   = mouseY - worldY * state.zoom;

    renderMap();

}, { passive: false });



/* ═══════════════════════════════════════════════════════════════

   ─── Limpar Histórico de Rolagens ───

═══════════════════════════════════════════════════════════════ */

window.clearDiceHistory = async () => {

    try {

        const { db, appId, collection, deleteDoc, doc, getDocs } = window.vtt;

        const col  = collection(db, 'artifacts', appId, 'public', 'data', 'dice-rolls');

        const snap = await getDocs(col);

        await Promise.all(snap.docs.map(d => deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'dice-rolls', d.id))));

    } catch (e) { console.error('[VTT] Erro ao limpar histórico:', e);

    }

};

/* ═══════════════════════════════════════════════════════════════

   ─── Presença Online ───

═══════════════════════════════════════════════════════════════ */

let presenceId = null;

let presenceHeartbeat = null;

let presenceUsers = [];

async function initPresence() {

    const { db, appId, doc, setDoc, deleteDoc, onSnapshot, collection } = window.vtt;

    const presenceCol = collection(db, 'artifacts', appId, 'public', 'data', 'presence');

    presenceId = 'user-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);

    const presenceRef = doc(presenceCol, presenceId);

    await setDoc(presenceRef, { role: state.role, name: state.playerName, ts: Date.now(), online: true });

    presenceHeartbeat = setInterval(async () => {

        try { await setDoc(presenceRef, { ts: Date.now(), online: true, role: state.role, name: state.playerName }, { merge: true }); } catch (e) {}

    }, 15000);



    window.addEventListener('beforeunload', async () => {

        clearInterval(presenceHeartbeat);

        try { await deleteDoc(presenceRef); } catch (e) {}

    });



    onSnapshot(presenceCol, (snap) => {

        const now = Date.now();

        const users = [];

        snap.forEach(d => {

            const data = d.data();

            if (data.online && (now - (data.ts || 0)) < 45000) users.push({ id: d.id, ...data });



        });

        renderPresence(users);

    }, (e) => console.error('[VTT] Sync presença:', e));

}

function renderPresence(users) {

    presenceUsers = users;

    const list = _el('presence-list');

    if (!list) return;

    if (!users.length) { list.innerHTML = '<p class="presence-empty">Nenhum usuário.</p>'; return;

    }

    users.sort((a, b) => (a.role === 'mestre' ? -1 : 1) - (b.role === 'mestre' ? -1 : 1));

    const jogadores = users.filter(u => u.role !== 'mestre');

    list.innerHTML = '';

    users.forEach(user => {

        const isMestre = user.role === 'mestre';

        const isSelf   = presenceId && user.id === presenceId;

        const label    = user.name || (isMestre ? 'Mestre' : 'Jogador ' + (jogadores.indexOf(user) + 1));

        const div = document.createElement('div');

        div.className = 'presence-entry';



        div.innerHTML =

            '<div class="presence-dot ' + (isMestre ? 'mestre' : 'online') + '"></div>' +

            '<span style="color:' + (isMestre ? '#fbbf24' : '#6EE7B7') + ';font-weight:700">' +

            label + (isSelf ? ' (você)' : '') + '</span>' +



            '<span class="presence-role">' + (isMestre ? 'Mestre' : 'Jogador') + '</span>';

        list.appendChild(div);

    });

}

/* ─── Enter no input de notação de dados ─── */

_el('dice-notation-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') window.rollNotation(); });

/* ═══════════════════════════════════════════════════════════════

   ─── Biblioteca de Fichas Salvas ───

═══════════════════════════════════════════════════════════════ */

/* Estado interno do modal de criação de preset */

    const presetState = {

        size: 1,

        type: 'PC',

        color: '#ffffff',

        imageUrl: null
    };

    const mapPresetState = {
        imageUrl: null
    };

    window.openMapPresetModal = () => {
        const nameInput = _el('map-preset-name-input');
        const modal = _el('map-preset-modal');
        if (!nameInput || !modal) return;
        nameInput.value = '';
        mapPresetState.imageUrl = null;
        _el('map-preset-img-preview').innerHTML = '<span id="map-preset-img-placeholder">🗺️</span>';
        modal.style.display = 'flex';
    };

    window.closeMapPresetModal = () => {
        _el('map-preset-modal').style.display = 'none';
    };


_el('f-map-preset').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        mapPresetState.imageUrl = ev.target.result;
        _el('map-preset-img-preview').innerHTML = `<img src="${ev.target.result}" alt="Preview">`;
    };
    reader.readAsDataURL(file);
};

/* ─ Abrir / Fechar Modal ─ */

    window.saveMapPreset = async () => {
        const name = (_el('map-preset-name-input').value || '').trim();
        if (!name) { _el('map-preset-name-input').focus(); return; }
        const data = {
            name,
            url:       mapPresetState.imageUrl || '',
            gridSize:  state.gridSize,
            gridType:  state.gridType,
            opacity:   state.opacity,
            mapWidth:  state.mapWidth,
            mapHeight: state.mapHeight,
            createdAt: Date.now()
        };
        try {
            const { db, appId, addDoc, collection } = window.vtt;
            await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'map-presets'), data);
            window.closeMapPresetModal();
            showToast('🗺️ Mapa salvo com sucesso!', 'success');
        } catch (err) {
            console.error('[VTT] Erro ao salvar mapa preset:', err);
            showToast('Erro ao salvar mapa', 'error');
        }
    };

    function renderMapPresets(presets) {
        const grid = _el('map-preset-grid');
        if (!grid) return;
        if (!presets.length) {
            grid.innerHTML = '<p class="preset-empty-state">Nenhum mapa salvo ainda.</p>';
            window.refreshAccordionHeights?.();
            return;
        }
        grid.innerHTML = '';
        presets.forEach(p => {
            const card = document.createElement('div');
            card.className = 'preset-card';
            card.title = `Carregar mapa: ${p.name}`;
            const thumb = document.createElement('div');
            thumb.className = 'preset-thumb';
            if (p.url) {
                const img = document.createElement('img');
                img.src = p.url; img.alt = p.name; img.loading = 'lazy';
                img.addEventListener('error', () => { thumb.textContent = '🗺️'; }, { once: true });
                thumb.appendChild(img);
            } else { thumb.textContent = '🗺️'; }
            const nameEl = document.createElement('span');
            nameEl.className = 'preset-name';
            nameEl.textContent = p.name;
            const metaEl = document.createElement('span');
            metaEl.className = 'preset-meta';
            metaEl.textContent = `${p.gridType || 'square'} · ${p.gridSize || 60}px`;
            const delBtn = document.createElement('div');
            delBtn.className = 'preset-del-btn';
            delBtn.innerHTML = '✕';
            delBtn.title = 'Remover mapa salvo';
            delBtn.onclick = (ev) => { ev.stopPropagation(); deleteMapPreset(p.id); };
            card.appendChild(thumb);
            card.appendChild(nameEl);
            card.appendChild(metaEl);
            card.appendChild(delBtn);
            card.addEventListener('click', () => applyMapPreset(p));
            grid.appendChild(card);
        });
        window.refreshAccordionHeights?.();
    }

    async function applyMapPreset(p) {
        if (!window.vtt) return;
        try {
            const { db, appId, doc, setDoc } = window.vtt;
            const newMaps = { ...state.maps };
            newMaps[state.activeLayer] = { url: p.url || '', width: p.mapWidth || 1200, height: p.mapHeight || 800 };
            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'world', 'current'), {
                maps: newMaps,
                grid:     p.gridSize || state.gridSize,
                opacity:  p.opacity  || state.opacity,
                gridType: p.gridType || state.gridType
            }, { merge: true });
            showToast(`🗺️ Mapa "${p.name}" carregado`, 'success');
        } catch (err) {
            console.error('[VTT] Erro ao aplicar mapa preset:', err);
            showToast('Erro ao carregar mapa', 'error');
        }
    }

    async function deleteMapPreset(id) {
        try {
            const { db, appId, deleteDoc, doc } = window.vtt;
            await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'map-presets', id));
            showToast('🗑️ Mapa removido', 'warn');
        } catch (err) {
            console.error('[VTT] Erro ao deletar mapa preset:', err);
            showToast('Erro ao remover mapa', 'error');
        }
    }

    function initMapPresets() {
        const { db, appId, onSnapshot, collection, query, orderBy } = window.vtt;
        onSnapshot(
            query(collection(db, 'artifacts', appId, 'public', 'data', 'map-presets'), orderBy('createdAt', 'asc')),
            (snap) => {
                const presets = [];
                snap.forEach(d => presets.push({ id: d.id, ...d.data() }));
                renderMapPresets(presets);
            },
            (e) => console.error('[VTT] Sync map presets:', e)
        );
    }

    /* ─ Abrir / Fechar Modal (fichas) ─ */

window.openPresetModal = () => {

    /* Reset do form */

    const nameInput = _el('preset-name-input');

    const hpInput = _el('preset-hp-input');

    const manaInput = _el('preset-mana-input');

    const modal = _el('preset-modal');

    if (!nameInput || !hpInput || !manaInput || !modal) return;

    nameInput.value = '';

    hpInput.value   = '';

    manaInput.value = '';

    presetState.size     = 1;

    presetState.type     = 'PC';

    presetState.color    = '#ffffff';

    presetState.imageUrl = null;

    /* Reset botões de tamanho */

    document.querySelectorAll('.preset-size-btn').forEach(b => b.classList.remove('active'));

    document.querySelector('.preset-size-btn[data-size="1"]')?.classList.add('active');

    /* Reset botões de tipo */

    _el('preset-type-pc').className  = 'preset-type-btn active-pc';

    _el('preset-type-npc').className = 'preset-type-btn';

    /* Reset swatches de cor */

    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));

    document.querySelector('.color-swatch[data-color="#ffffff"]')?.classList.add('selected');

    /* Reset preview da imagem */

    const preview = _el('preset-img-preview');

    if (preview) preview.innerHTML = '<span id="preset-img-placeholder">🧙</span>';

    modal.classList.add('open');

    setTimeout(() => nameInput.focus(), 50);

};

const presetOpenBtn = _el('btn-open-preset-modal');

if (presetOpenBtn) {

    presetOpenBtn.addEventListener('click', (e) => {

        e.preventDefault();

        window.openPresetModal();

    });

}

window.closePresetModal = () => {

    _el('preset-modal').classList.remove('open');

    _el('f-preset').value = '';

    presetState.imageUrl = null;

};

/* ─ Seletores do Modal ─ */

window.selectPresetSize = (size) => {

    presetState.size = size;

    document.querySelectorAll('.preset-size-btn').forEach(b => b.classList.remove('active'));

    document.querySelector(`.preset-size-btn[data-size="${size}"]`)?.classList.add('active');

};

window.selectPresetType = (type) => {

    presetState.type = type;

    _el('preset-type-pc').className  = 'preset-type-btn' + (type === 'PC'  ? ' active-pc'  : '');

    _el('preset-type-npc').className = 'preset-type-btn' + (type === 'NPC' ? ' active-npc' : '');

};

window.selectPresetColor = (color) => {

    presetState.color = color;

    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));

    document.querySelector(`.color-swatch[data-color="${color}"]`)?.classList.add('selected');

};

/* ─ Upload da imagem do preset ─ */

_el('f-preset').onchange = (e) => {

    const file = e.target.files[0];

    if (!file) return;

    const img = new Image(), reader = new FileReader();

    reader.onload = (ev) => {

        img.src = ev.target.result;

        img.onload = () => {

            const canvas = document.createElement('canvas');

            canvas.width = canvas.height = 128;

            canvas.getContext('2d').drawImage(img, 0, 0, 128, 128);

            let url = canvas.toDataURL('image/webp', 0.8);

            if (!url.startsWith('data:image/webp')) {

                let q = 0.8;

                url = canvas.toDataURL('image/jpeg', q);

                while (url.length > 50000 && q > 0.2) { q -= 0.1; url = canvas.toDataURL('image/jpeg', q); }

            }

            presetState.imageUrl = url;

            /* Atualiza preview no modal */

            const preview = _el('preset-img-preview');

            preview.innerHTML = `<img src="${url}" alt="preview">`;

        };

    };

    reader.readAsDataURL(file);

    e.target.value = '';

};

/* ─ Salvar Preset no Firestore ─ */

window.savePreset = async () => {

    const name = _el('preset-name-input').value.trim();

    if (!name) { _el('preset-name-input').focus(); return; }

    const hp    = parseInt(_el('preset-hp-input').value)   || 0;

    const mana  = parseInt(_el('preset-mana-input').value) || 0;

    const data = {

        name,

        url:       presetState.imageUrl || '',

        maxHp:     hp,

        maxMana:   mana,

        tokenSize: presetState.size,

        type:      presetState.type,

        color:     presetState.color,

        createdAt: Date.now()

    };

    try {

        const { db, appId, addDoc, collection } = window.vtt;

        await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'token-presets'), data);

        closePresetModal();

        showToast('📚 Ficha salva com sucesso!', 'success');

    } catch (err) {

        console.error('[VTT] Erro ao salvar preset:', err);

        showToast('Erro ao salvar ficha', 'error');

    }

};

/* ─ Renderizar Cards ─ */

function renderPresets(presets) {

    const grid = _el('preset-grid');

    if (!grid) return;

    if (!presets.length) {

        grid.innerHTML = '<p class="preset-empty-state">Nenhuma ficha salva ainda.</p>';

        window.refreshAccordionHeights?.();

        return;

    }

    grid.innerHTML = '';

    presets.forEach(p => {

        const card = document.createElement('div');

        card.className = 'preset-card';

        card.title = `Spawnar ${p.name} no mapa`;

        /* Thumbnail */

        const thumb = document.createElement('div');

        thumb.className = 'preset-thumb';

        thumb.style.borderColor = p.color || '#5C6BC0';

        if (p.url) {

            const img = document.createElement('img');

            img.src = p.url;

            img.alt = p.name;

            img.loading = 'lazy';

            img.addEventListener('error', () => {

                thumb.textContent = p.type === 'NPC' ? '👹' : '🧙';

            }, { once: true });

            thumb.appendChild(img);

        } else {

            thumb.textContent = p.type === 'NPC' ? '👹' : '🧙';

        }

        /* Badge de tipo */

        const badge = document.createElement('span');

        badge.className = `preset-type ${p.type === 'PC' ? 'pc' : 'npc'}`;

        badge.textContent = p.type;

        /* Nome */

        const nameEl = document.createElement('span');

        nameEl.className = 'preset-name';

        nameEl.textContent = p.name;

        /* Meta (HP / Tamanho) */

        const metaEl = document.createElement('span');

        metaEl.className = 'preset-meta';

        const parts = [];

        if (p.maxHp)   parts.push(`❤️ ${p.maxHp}`);

        if (p.maxMana) parts.push(`💙 ${p.maxMana}`);

        if (p.tokenSize > 1) parts.push(`${p.tokenSize}×${p.tokenSize}`);

        metaEl.textContent = parts.join(' · ') || '—';

        /* Botão deletar */

        const delBtn = document.createElement('div');

        delBtn.className = 'preset-del-btn';

        delBtn.innerHTML = '✕';

        delBtn.title = 'Remover ficha';

        delBtn.onclick = (ev) => {

            ev.stopPropagation();

            deletePreset(p.id);

        };

        card.appendChild(thumb);

        card.appendChild(badge);

        card.appendChild(nameEl);

        card.appendChild(metaEl);

        card.appendChild(delBtn);

        card.addEventListener('click', () => spawnPreset(p));

        grid.appendChild(card);

    });

    window.refreshAccordionHeights?.();

}

/* ─ Spawnar Token a Partir do Preset ─ */

async function spawnPreset(p) {

    if (!window.vtt) return;

    /* Calcula posição central do viewport visível em coordenadas do mapa */

    const vw = viewport.clientWidth  / 2;

    const vh = viewport.clientHeight / 2;

    const rawX = (vw - state.pan.x) / state.zoom;

    const rawY = (vh - state.pan.y) / state.zoom;

    const { x, y } = snapHex(rawX - (state.gridSize * (p.tokenSize || 1)) / 2,

                               rawY - (state.gridSize * (p.tokenSize || 1)) / 2);

    try {

        const { db, appId, addDoc, collection } = window.vtt;

        await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tokens'), {

            url:        p.url  || '',

            x, y,

            name:       p.name || '',

            color:      p.color || '#ffffff',

            tokenSize:  p.tokenSize || 1,

            layer:      state.activeLayer,

            hp:         p.maxHp   || 0,

            maxHp:      p.maxHp   || 0,

            mana:       p.maxMana || 0,

            maxMana:    p.maxMana || 0,

            conditions: [],

            playerControlled: p.type === 'PC'

        });

        showToast(`⚡ ${p.name} adicionado ao mapa`, 'success');

    } catch (err) {

        console.error('[VTT] Erro ao spawnar preset:', err);

        showToast('Erro ao spawnar token', 'error');

    }

}

/* ─ Deletar Preset ─ */

async function deletePreset(id) {

    try {

        const { db, appId, deleteDoc, doc } = window.vtt;

        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'token-presets', id));

        showToast('🗑️ Ficha removida', 'warn');

    } catch (err) {

        console.error('[VTT] Erro ao deletar preset:', err);

        showToast('Erro ao remover ficha', 'error');

    }

}

/* ─ Iniciar listener de Presets (chamado após autenticação) ─ */

function initPresets() {

    const { db, appId, onSnapshot, collection, query, orderBy } = window.vtt;

    onSnapshot(

        query(collection(db, 'artifacts', appId, 'public', 'data', 'token-presets'), orderBy('createdAt', 'asc')),

        (snap) => {

            const presets = [];

            snap.forEach(d => presets.push({ id: d.id, ...d.data() }));

            renderPresets(presets);

        },

        (e) => console.error('[VTT] Sync presets:', e)

    );

}

/* ─ Atalho de teclado Enter/Escape no modal de preset ─ */

_el('preset-modal').addEventListener('keydown', (e) => {

    if (e.key === 'Enter') window.savePreset();

    if (e.key === 'Escape') window.closePresetModal();

});

/* ═══════════════════════════════════════════════════════════════

   ─── Toast Notifications ───

═══════════════════════════════════════════════════════════════ */

function showToast(msg, type = 'info', duration = 2000) {

    const container = document.getElementById('toast-container');

    if (!container) return;

    const t = document.createElement('div');

    t.className = 'vtt-toast toast-' + type;

    t.textContent = msg;

    container.appendChild(t);

    /* Anima entrada */

    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));

    /* Remove após duração */

    setTimeout(() => {

        t.classList.remove('show');

        setTimeout(() => t.remove(), 300);

    }, duration);

};

/* ═══════════════════════════════════════════════════════════════

   ─── Seleção de Tokens ───

═══════════════════════════════════════════════════════════════ */

function clearSelection() {

    state.selectedTokenIds.forEach(tid => {

        const w = document.getElementById('tw-' + tid);

        if (w) w.classList.remove('selected');

    });

    state.selectedTokenIds.clear();

}
