// Easy Read PDF — PWA app logic with dual view modes
// Uses patched PDF.js worker that exposes font.bold via textContent.styles

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.patched.js?v=13';

// ---------- Element refs ----------
const fileInput = document.getElementById('file-input');
const home = document.getElementById('home');
const reader = document.getElementById('reader');
const content = document.getElementById('content');
const docTitle = document.getElementById('doc-title');
const docMeta = document.getElementById('doc-meta');
const sizeControls = document.getElementById('size-controls');
const sizeLabel = document.getElementById('size-label');
const themeBtn = document.getElementById('theme-btn');
const installBanner = document.getElementById('ios-install-banner');
const bannerClose = document.getElementById('banner-close');
const modeToggle = document.getElementById('mode-toggle');

// ---------- App state ----------
let currentPdf = null;
let currentParagraphs = null;   // [{segments: [{text, bold}], plainText}]
let currentMode = 'reflow';
let originalRenderInProgress = false;

// ---------- Persisted settings ----------
const STORE = {
  fontSize: 'erpdf:fontSize',
  theme: 'erpdf:theme',
  iosBannerSeen: 'erpdf:iosBannerSeen',
};

let currentSize = parseInt(localStorage.getItem(STORE.fontSize) || '22', 10);
applySize(currentSize);

let currentTheme = localStorage.getItem(STORE.theme) || 'system';
applyTheme(currentTheme);

// ---------- Theme ----------
function applyTheme(mode) {
  currentTheme = mode;
  if (mode === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', mode);
  }
  const isDark =
    mode === 'dark' ||
    (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  themeBtn.textContent = isDark ? '☀️' : '🌙';
  localStorage.setItem(STORE.theme, mode);
}

themeBtn.addEventListener('click', () => {
  const sysIsDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const currentlyDark =
    currentTheme === 'dark' ||
    (currentTheme === 'system' && sysIsDark);
  applyTheme(currentlyDark ? 'light' : 'dark');
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (currentTheme === 'system') applyTheme('system');
});

// ---------- Font size ----------
function applySize(size) {
  currentSize = Math.max(14, Math.min(48, size));
  document.documentElement.style.setProperty('--reader-size', currentSize + 'px');
  if (sizeLabel) sizeLabel.textContent = currentSize;
  localStorage.setItem(STORE.fontSize, String(currentSize));
}

document.getElementById('size-up').addEventListener('click', () => applySize(currentSize + 2));
document.getElementById('size-down').addEventListener('click', () => applySize(currentSize - 2));

// ---------- Mode toggle ----------
modeToggle.addEventListener('click', async () => {
  if (!currentPdf) return;
  if (currentMode === 'reflow') {
    await switchToOriginalMode();
  } else {
    switchToReflowMode();
  }
});

function updateModeToggle() {
  if (currentMode === 'reflow') {
    modeToggle.textContent = '원본 보기';
    modeToggle.title = '원본 PDF 보기 모드로 전환';
  } else {
    modeToggle.textContent = '큰 글자';
    modeToggle.title = '큰 글자 읽기 모드로 전환';
  }
  sizeControls.style.display = 'flex';
}

function switchToReflowMode() {
  currentMode = 'reflow';
  content.classList.remove('original-mode');
  content.classList.add('reflow-mode');
  renderReflowParagraphs(currentParagraphs);
  updateModeToggle();
}

async function switchToOriginalMode() {
  currentMode = 'original';
  content.classList.remove('reflow-mode');
  content.classList.add('original-mode');
  await renderOriginalPdf();
  updateModeToggle();
}

// ---------- iOS install hint ----------
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}
function isSafari() {
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

if (isIOS() && isSafari() && !isStandalone() && !localStorage.getItem(STORE.iosBannerSeen)) {
  installBanner.classList.remove('hidden');
}

bannerClose.addEventListener('click', () => {
  installBanner.classList.add('hidden');
  localStorage.setItem(STORE.iosBannerSeen, '1');
});

// ---------- File handling ----------
fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

async function handleFile(file) {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    alert('PDF 파일만 지원해요.');
    return;
  }

  const title = file.name.replace(/\.pdf$/i, '');

  home.style.display = 'none';
  installBanner.classList.add('hidden');
  reader.classList.add('active');
  docTitle.textContent = title;
  docMeta.textContent = '불러오는 중...';
  content.innerHTML =
    '<div class="status"><div class="loader"></div><div>PDF를 읽는 중...</div></div>';

  try {
    const arrayBuffer = await file.arrayBuffer();
    currentPdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    // Build font style map (bold/italic) across all pages.
    // The patched worker exposes `bold`, `black`, `italic` in styles.
    const fontStyleMap = new Map();
    const perPageItems = [];

    for (let i = 1; i <= currentPdf.numPages; i++) {
      const page = await currentPdf.getPage(i);
      const textContent = await page.getTextContent();

      if (textContent.styles) {
        for (const [fontName, style] of Object.entries(textContent.styles)) {
          if (!fontStyleMap.has(fontName)) {
            fontStyleMap.set(fontName, {
              bold: style.bold === true || style.black === true,
              italic: style.italic === true,
            });
          }
        }
      }

      perPageItems.push(textContent.items);
    }

    // Build lines with bold/italic information
    const perPageLines = perPageItems.map((items) => buildLines(items, fontStyleMap));
    const headerFooterSet = detectHeaderFooter(perPageLines);

    const allLines = [];
    for (const pageLines of perPageLines) {
      for (const line of pageLines) {
        if (shouldFilterLine(line, headerFooterSet)) continue;
        allLines.push(line);
      }
      allLines.push({ segments: [], plainText: '' });
    }

    currentParagraphs = parseParagraphs(allLines);

    docMeta.textContent = `${currentPdf.numPages}페이지 · ${currentParagraphs.length}단락`;

    switchToReflowMode();
    modeToggle.style.display = 'inline-block';
  } catch (err) {
    console.error(err);
    content.innerHTML = `
      <div class="status">
        <div class="error-icon">⚠️</div>
        <div>PDF를 읽지 못했어요</div>
        <div style="margin-top:8px;font-size:12px;opacity:0.7">
          스캔된 이미지 PDF는 텍스트 추출이 안 될 수 있어요
        </div>
      </div>`;
  }
}

// ---------- Reflow mode rendering ----------
function renderReflowParagraphs(paragraphs) {
  content.innerHTML = '';

  const numberPattern = /^(\d{1,2}[.)])\s+([\s\S]*)/;
  const bulletPattern = /^[•●○◦▪▫■□‣⁃▶▸◆◇★☆※⦁\-*]\s*/;

  for (const para of paragraphs) {
    const p = document.createElement('p');
    const text = para.plainText;
    const m = text.match(numberPattern);

    if (m) {
      // Numbered item: marker + content (with bold preserved)
      const numSpan = document.createElement('span');
      numSpan.className = 'item-num';
      numSpan.textContent = m[1];
      p.appendChild(numSpan);
      p.appendChild(document.createTextNode(' '));

      const skipChars = m[1].length + (text.length - m[2].length - m[1].length);
      renderSegments(p, para.segments, skipChars);
    } else if (bulletPattern.test(text)) {
      // Bullet item: indent slightly, render content as-is
      p.classList.add('bullet-item');
      renderSegments(p, para.segments, 0);
    } else {
      renderSegments(p, para.segments, 0);
    }

    content.appendChild(p);
  }
}

function renderSegments(p, segments, skipChars) {
  let remaining = skipChars;
  let firstNode = true;
  for (const seg of segments) {
    let text = seg.text;
    if (remaining > 0) {
      if (text.length <= remaining) {
        remaining -= text.length;
        continue;
      }
      text = text.slice(remaining);
      remaining = 0;
    }
    if (firstNode) {
      text = text.replace(/^\s+/, '');
      firstNode = false;
    }
    if (!text) continue;

    // Wrap with <strong> and/or <em> based on segment style
    let node = document.createTextNode(text);
    if (seg.italic) {
      const em = document.createElement('em');
      em.appendChild(node);
      node = em;
    }
    if (seg.bold) {
      const strong = document.createElement('strong');
      strong.appendChild(node);
      node = strong;
    }
    p.appendChild(node);
  }
}

// ---------- Original mode rendering ----------
async function renderOriginalPdf() {
  if (originalRenderInProgress) return;
  originalRenderInProgress = true;

  content.innerHTML =
    '<div class="status"><div class="loader"></div><div>원본 PDF를 불러오는 중...</div></div>';

  try {
    content.innerHTML = '';

    const containerWidth = content.clientWidth - 8;
    // Render at higher resolution than the device pixel ratio so that
    // pinch-zoom stays sharp. SUPERSAMPLE = 1.75 gives ~3x sharper than
    // the displayed size on a typical 2x-DPR phone screen.
    const SUPERSAMPLE = 1.75;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * SUPERSAMPLE;
    const userZoom = currentSize / 22;

    for (let i = 1; i <= currentPdf.numPages; i++) {
      const page = await currentPdf.getPage(i);

      const baseViewport = page.getViewport({ scale: 1 });
      const fitScale = containerWidth / baseViewport.width;
      const scale = fitScale * userZoom;
      const viewport = page.getViewport({ scale });

      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page-canvas';
      // Logical CSS size (what the user sees)
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      // Backing store size (oversampled for pinch zoom sharpness)
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);

      wrapper.appendChild(canvas);
      content.appendChild(wrapper);

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      await page.render({
        canvasContext: ctx,
        viewport,
      }).promise;
    }
  } catch (err) {
    console.error(err);
    content.innerHTML =
      '<div class="status"><div class="error-icon">⚠️</div><div>원본 PDF를 불러오지 못했어요</div></div>';
  } finally {
    originalRenderInProgress = false;
  }
}

let resizeDebounce = null;
function scheduleOriginalRerender() {
  if (currentMode !== 'original' || !currentPdf) return;
  clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(() => {
    renderOriginalPdf();
  }, 200);
}

document.getElementById('size-up').addEventListener('click', scheduleOriginalRerender);
document.getElementById('size-down').addEventListener('click', scheduleOriginalRerender);

window.addEventListener('resize', () => {
  if (currentMode === 'original') scheduleOriginalRerender();
});

// ---------- Text extraction with bold ----------
function buildLines(items, fontStyleMap) {
  if (!items.length) return [];

  const lines = [];
  let currentSegments = [];
  let currentY = null;
  let lineMinX = Infinity;
  let lineMaxX = -Infinity;
  let lineY = null;

  function pushLine() {
    if (currentSegments.length === 0) return;
    const merged = mergeAdjacentSegments(currentSegments);
    const plainText = merged.map((s) => s.text).join('');
    if (plainText.trim()) {
      const lastSeg = merged[merged.length - 1];
      const firstSeg = merged[0];
      lines.push({
        segments: merged,
        plainText,
        // Layout info for paragraph break detection
        xStart: lineMinX,
        xEnd: lineMaxX,
        y: lineY,
        endsBold: lastSeg.bold === true,
        startsBold: firstSeg.bold === true,
      });
    }
    currentSegments = [];
    lineMinX = Infinity;
    lineMaxX = -Infinity;
    lineY = null;
  }

  function recordItemBox(item) {
    const x = item.transform[4];
    const w = item.width || 0;
    if (x < lineMinX) lineMinX = x;
    if (x + w > lineMaxX) lineMaxX = x + w;
    if (lineY === null) lineY = item.transform[5];
  }

  for (const item of items) {
    const y = Math.round(item.transform[5]);
    const text = item.str;
    const fs = fontStyleMap.get(item.fontName) || { bold: false, italic: false };
    const bold = fs.bold === true;
    const italic = fs.italic === true;

    if (currentY === null) {
      currentY = y;
      if (text) {
        currentSegments.push({ text, bold, italic });
        recordItemBox(item);
      }
      if (item.hasEOL) { pushLine(); currentY = null; }
      continue;
    }

    if (Math.abs(y - currentY) < 3) {
      if (text) {
        currentSegments.push({ text, bold, italic });
        recordItemBox(item);
      }
    } else {
      pushLine();
      currentY = y;
      if (text) {
        currentSegments.push({ text, bold, italic });
        recordItemBox(item);
      }
    }

    if (item.hasEOL) {
      pushLine();
      currentY = null;
    }
  }
  pushLine();

  // ----- Multi-column layout detection -----
  // If lines split into two clear X-position clusters (e.g. 2-column landscape
  // PDFs from Google Docs), reorder them so each column reads top-to-bottom
  // first, then move to the next column. Without this, lines from both
  // columns get interleaved by content-stream order, making paragraphs
  // hopelessly fragmented.
  return reorderColumns(lines);
}

/**
 * Detect 1- vs 2-column layout based on xStart distribution and reorder
 * lines so each column is contiguous (top-to-bottom).
 */
function reorderColumns(lines) {
  if (lines.length < 6) return lines; // too few to bother

  const xStarts = lines
    .map((l) => l.xStart)
    .filter((x) => x !== undefined && x !== Infinity)
    .sort((a, b) => a - b);

  if (xStarts.length < 6) return lines;

  // Find the overall horizontal span
  const minX = xStarts[0];
  const maxX = xStarts[xStarts.length - 1];
  const span = maxX - minX;
  if (span < 100) return lines; // narrow page, single column

  // Look for a gap in xStart distribution that's wider than ~25% of the span.
  // That gap is the column separator.
  let bestGap = 0;
  let bestGapMid = -1;
  for (let i = 1; i < xStarts.length; i++) {
    const gap = xStarts[i] - xStarts[i - 1];
    if (gap > bestGap) {
      bestGap = gap;
      bestGapMid = (xStarts[i] + xStarts[i - 1]) / 2;
    }
  }

  // Require the gap to be large (a real column gutter, not just word spacing)
  if (bestGap < span * 0.2) return lines; // single column

  // Also require both sides of the split to have a meaningful number of lines
  const leftCount = lines.filter((l) => l.xStart < bestGapMid).length;
  const rightCount = lines.length - leftCount;
  if (leftCount < 3 || rightCount < 3) return lines;

  // It's 2-column. Split, sort each side by Y descending (PDF coords:
  // larger Y = higher on page), then concatenate left then right.
  const left = lines.filter((l) => l.xStart < bestGapMid);
  const right = lines.filter((l) => l.xStart >= bestGapMid);

  const sortByYDesc = (a, b) => {
    const ya = a.y !== null && a.y !== undefined ? a.y : 0;
    const yb = b.y !== null && b.y !== undefined ? b.y : 0;
    return yb - ya;
  };

  left.sort(sortByYDesc);
  right.sort(sortByYDesc);

  // Tag each line with its column so paragraph parsing knows where to
  // compute its own "right edge" baseline.
  for (const l of left) l.column = 'left';
  for (const l of right) l.column = 'right';

  return [...left, ...right];
}

function mergeAdjacentSegments(segments) {
  const result = [];
  for (const seg of segments) {
    const last = result.length > 0 ? result[result.length - 1] : null;
    if (last && last.bold === seg.bold && last.italic === seg.italic) {
      last.text += seg.text;
    } else {
      result.push({ text: seg.text, bold: seg.bold, italic: seg.italic });
    }
  }
  return result;
}

function detectHeaderFooter(perPageLines) {
  if (perPageLines.length < 2) return new Set();

  const EDGE_LINES = 3;
  const counts = new Map();

  for (const lines of perPageLines) {
    const candidates = new Set();
    let added = 0;
    for (let i = 0; i < lines.length && added < EDGE_LINES; i++) {
      const t = (lines[i]?.plainText || '').trim();
      if (!t) continue;
      candidates.add(normalizeForRepeatDetection(t));
      added++;
    }
    added = 0;
    for (let i = lines.length - 1; i >= 0 && added < EDGE_LINES; i--) {
      const t = (lines[i]?.plainText || '').trim();
      if (!t) continue;
      candidates.add(normalizeForRepeatDetection(t));
      added++;
    }
    for (const c of candidates) {
      counts.set(c, (counts.get(c) || 0) + 1);
    }
  }

  const totalPages = perPageLines.length;
  const minRepeats = totalPages <= 3 ? 2 : Math.ceil(totalPages * 0.3);

  const repeats = new Set();
  for (const [norm, count] of counts) {
    if (count >= minRepeats && norm.length > 0) {
      repeats.add(norm);
    }
  }
  return repeats;
}

function normalizeForRepeatDetection(text) {
  return text
    .replace(/\b\d+\s*\/\s*\d+\b/g, '')
    .replace(/\bpage\s*\d+\b/gi, '')
    .replace(/-\s*\d+\s*-/g, '')
    .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '')
    .replace(/\d{1,2}:\d{2}(\s*[APap][Mm])?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function shouldFilterLine(line, headerFooterSet) {
  const trimmed = (line.plainText || '').trim();
  if (!trimmed) return false;

  const norm = normalizeForRepeatDetection(trimmed);
  if (norm && headerFooterSet.has(norm)) return true;

  if (/^\s*(?:page\s*)?\d{1,3}\s*(?:\/\s*\d{1,3})?\s*$/i.test(trimmed)) return true;
  if (/^\s*-\s*\d+\s*-\s*$/.test(trimmed)) return true;
  if (/file:\/\/\//i.test(trimmed)) return true;
  if (/^https?:\/\/\S+\s*\d*\s*\/?\s*\d*\s*$/i.test(trimmed)) return true;

  return false;
}

function parseParagraphs(lines) {
  // New paragraph starts on:
  // - numbered marker like "1. " or "2)"
  // - bullet character at start of line
  // - common ASCII bullets like "- " or "* " followed by content
  const numberedStart = /^\s*\d{1,2}[.)]\s+\S/;
  const bulletStart = /^\s*[•●○◦▪▫■□‣⁃▶▸◆◇★☆※⦁]\s*/;
  const dashStart = /^\s*[-*]\s+\S/;
  const isItemStart = (text) =>
    numberedStart.test(text) || bulletStart.test(text) || dashStart.test(text);

  // Compute the "typical" right edge per column.
  // For 2-column layouts, the left column ends much earlier than the right,
  // so a single page-wide pageRightEdge gives bogus results.
  function rightEdgeFor(filterFn) {
    const xs = lines
      .filter((l) => l.xEnd !== undefined && l.xEnd > -Infinity && filterFn(l))
      .map((l) => l.xEnd)
      .sort((a, b) => a - b);
    if (xs.length === 0) return 0;
    return xs[Math.floor(xs.length * 0.8)];
  }
  const rightEdgeAll = rightEdgeFor(() => true);
  const rightEdgeLeft = rightEdgeFor((l) => l.column === 'left');
  const rightEdgeRight = rightEdgeFor((l) => l.column === 'right');

  function pageRightEdgeFor(line) {
    if (line.column === 'left' && rightEdgeLeft > 0) return rightEdgeLeft;
    if (line.column === 'right' && rightEdgeRight > 0) return rightEdgeRight;
    return rightEdgeAll;
  }

  // Sentence-ending punctuation. We require this for paragraph end.
  const sentenceEndRe = /[.!?。!?…")'’”]\s*$/;

  function endsParagraph(line, nextLine) {
    if (!line || line.xEnd === undefined || line.xEnd <= -Infinity) return false;
    const text = (line.plainText || '').trimEnd();
    if (!text) return false;

    const re = pageRightEdgeFor(line);
    if (re <= 0) return false;

    const endsWithSentence = sentenceEndRe.test(text);
    const isShort = line.xEnd < re * 0.92;
    const isVeryShort = line.xEnd < re * 0.55;

    // (a) Very short lines that end with sentence punctuation
    if (isVeryShort && endsWithSentence) return true;

    // (b) Bold-to-regular transition with a short line
    if (isShort && line.endsBold && nextLine && !nextLine.startsBold) return true;

    // (c) Short line ending with sentence punctuation
    if (isShort && endsWithSentence) return true;

    return false;
  }

  const paragraphs = [];
  let buffer = [];

  function flush() {
    if (buffer.length === 0) return;
    const allSegs = [];
    for (let i = 0; i < buffer.length; i++) {
      if (i > 0) {
        const last = allSegs.length > 0 ? allSegs[allSegs.length - 1] : null;
        const lastBold = last ? last.bold : false;
        const lastItalic = last ? last.italic : false;
        allSegs.push({ text: ' ', bold: lastBold, italic: lastItalic });
      }
      for (const seg of buffer[i].segments) {
        allSegs.push({ text: seg.text, bold: seg.bold, italic: seg.italic });
      }
    }
    const merged = mergeAdjacentSegments(allSegs);
    const cleaned = merged
      .map((s) => ({ text: s.text.replace(/\s+/g, ' '), bold: s.bold, italic: s.italic }))
      .filter((s) => s.text.length > 0);

    const plainText = cleaned.map((s) => s.text).join('').trim();
    if (plainText) {
      paragraphs.push({ segments: cleaned, plainText });
    }
    buffer = [];
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const nextLine = lines[idx + 1];
    const trimmed = (line.plainText || '').trim();

    if (!trimmed) {
      // Empty line: this is either a real blank line OR a page boundary marker.
      // We DON'T want page boundaries to always end paragraphs, because a
      // paragraph can flow across pages. Only flush if the buffer's last line
      // looks like a real paragraph ending: short AND ends with sentence
      // punctuation, OR very short (heading-like) and ends with punctuation.
      if (buffer.length > 0) {
        const lastBufLine = buffer[buffer.length - 1];
        const lastText = (lastBufLine.plainText || '').trimEnd();
        const endsWithPunct = sentenceEndRe.test(lastText);
        const xe = lastBufLine.xEnd;
        const hasX = xe !== undefined && xe > -Infinity;
        const re = pageRightEdgeFor(lastBufLine);
        const lastIsShort = hasX && re > 0 && xe < re * 0.92;
        const lastIsVeryShort = hasX && re > 0 && xe < re * 0.55;

        if (lastIsShort && endsWithPunct) {
          flush();
        } else if (lastIsVeryShort && endsWithPunct) {
          flush();
        }
      }
      continue;
    }

    // Item-start lines always begin a new paragraph
    if (isItemStart(trimmed)) {
      flush();
      buffer.push(line);
    } else {
      buffer.push(line);
    }

    // Column transition (left → right in 2-column layouts):
    // A long sentence may flow from the bottom of the left column into the
    // top of the right column, so we should NOT force a paragraph break here.
    // Only end the paragraph if the last left-column line shows real
    // ending signals (sentence-ending punctuation), same as page-boundary
    // logic. Otherwise the paragraph keeps flowing into the next column.
    const nextIsDifferentColumn =
      nextLine && line.column && nextLine.column &&
      line.column !== nextLine.column;

    if (nextIsDifferentColumn) {
      const lastText = (line.plainText || '').trimEnd();
      const endsWithPunct = sentenceEndRe.test(lastText);
      // For column transitions, we use a softer rule than for in-column
      // breaks: the last line of a column is naturally short (it just
      // ran out of column height), so we can't use shortness as a signal.
      // We rely solely on sentence-ending punctuation.
      if (endsWithPunct) {
        flush();
      }
      continue;
    }

    // Skip layout-based break detection at the page boundary —
    // the last line on a page is naturally short.
    const nextIsPageBreak = nextLine && !((nextLine.plainText || '').trim());
    if (nextIsPageBreak) continue;

    // Layout-based paragraph end check
    if (endsParagraph(line, nextLine)) {
      flush();
    }
  }
  flush();

  return paragraphs;
}

// ---------- Service worker ----------
// Register service worker for offline support.
// First visit caches the app shell; subsequent visits work offline.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .then((reg) => {
        console.log('[ERPDF] SW registered:', reg.scope);
      })
      .catch((err) => {
        console.warn('[ERPDF] SW registration failed:', err);
      });
  });
}
