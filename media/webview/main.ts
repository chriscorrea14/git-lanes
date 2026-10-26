import './style.css';
import { computeLayout, type Alignment, type Layout, type LayoutNode } from '../../src/graph/layout';
import type { FileChange, HostMessage, LineStats, PushMode, Settings, WebviewMessage } from '../../src/protocol';
import type { RebaseState } from '../../src/rebase/execute';
import type { MergeState } from '../../src/merge/merge';
import { checkoutTarget } from '../../src/graph/checkout';
import { draggableLane, invalidTargets } from '../../src/rebase/plan';
import type { MergedInfo } from '../../src/git/merged';
import type { RawGraph } from '../../src/types';

declare function acquireVsCodeApi(): { postMessage(m: WebviewMessage): void };
const vscode = acquireVsCodeApi();
const send = (m: WebviewMessage) => vscode.postMessage({ ...m, t: Date.now() });

const LANE_W = 28;
const ROW_H = 24;
const PAD_X = 16;
const DOT_R = 5;
const HEADER_MIN = 40;
const HEADER_MAX = 400;
/** Lane names are rotated by this much; it decides how much name fits in the header height. */
const LABEL_ANGLE = 50;
const SVG_NS = 'http://www.w3.org/2000/svg';

interface State {
  raw?: RawGraph;
  settings: Settings;
  rebase: RebaseState | null;
  merging: MergeState | null;
  repoName: string;
  layout?: Layout;
  expandedGaps: Set<string>;
  selection: string[];
  files?: { shas: string[]; files: FileChange[]; left: string; right: string };
  pinned?: string;
  busy: boolean;
  error?: string;
  /** Squash/rebase-merged branches, by name (valid while the branch tip matches). */
  merged: Record<string, MergedInfo>;
  /** Merged-in side chains already on trunk, by chain top: not drawn. */
  chains: Record<string, MergedInfo>;
}

const state: State = {
  settings: { alignment: 'top', subjects: 'head', headerHeight: 120, showMergedLanes: true },
  rebase: null,
  merging: null,
  repoName: '',
  expandedGaps: new Set(),
  selection: [],
  busy: false,
  merged: {},
  chains: {},
};

/** Merge info for a branch, if it still applies to the branch's current tip. */
function mergedInfo(name: string | undefined): MergedInfo | undefined {
  if (!name || !state.raw) return undefined;
  const m = state.merged[name];
  const b = state.raw.branches.find((x) => x.name === name);
  return m && b && m.tip === b.tip ? m : undefined;
}

const mergedText = (m: MergedInfo) =>
  `${m.how === 'squash' ? 'Squash' : 'Rebase'}-merged into ${state.raw!.trunk.name} as ${m.trunkCommit.slice(0, 10)}` +
  (m.via ? `, via ${m.via} (your local branch is behind it)` : '');

// ---------- DOM skeleton ----------

const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="toolbar">
    <span class="repo"></span>
    <button data-act="refresh" title="Refresh">⟳ Refresh</button>
    <label>Align
      <select class="align">
        <option value="top">Tips at top</option>
        <option value="forkPoint">Near fork point</option>
      </select>
    </label>
    <label title="Draw lanes for commits merged into a branch from elsewhere. Off: merges show as diamonds; hover one to see what it merged."><input type="checkbox" class="merged-lanes"> Merged lanes</label>
    <button data-act="more" title="Load 100 more trunk commits">More history</button>
    <span class="hint">Click: details · Ctrl/⌘-click: compare two · Drag a branch commit onto another commit: rebase</span>
  </div>
  <div class="banner hidden"></div>
  <div class="error hidden"></div>
  <div class="main">
    <div class="scroller">
      <div class="headers"></div>
      <svg class="graph" xmlns="${SVG_NS}"></svg>
    </div>
    <div class="details hidden"></div>
  </div>
  <div class="popover hidden"></div>
  <div class="ghost hidden"></div>
  <div class="modal-backdrop hidden">
    <form class="modal push-dialog" role="dialog" aria-labelledby="push-title">
      <h3 id="push-title">Push branch <span class="push-branch"></span></h3>
      <label class="row">Remote <select name="remote"></select></label>
      <label class="row"><input type="checkbox" name="setUpstream" checked> Set upstream</label>
      <fieldset>
        <legend>Push mode</legend>
        <label><input type="radio" name="mode" value="normal" checked> Normal</label>
        <label><input type="radio" name="mode" value="forceWithLease"> Force with lease <span class="muted">(refuses if the remote has commits you haven't fetched)</span></label>
        <label><input type="radio" name="mode" value="force"> Force <span class="muted">(overwrites the remote branch)</span></label>
      </fieldset>
      <div class="modal-buttons">
        <button type="submit" class="primary">Push</button>
        <button type="button" data-act="cancel">Cancel</button>
      </div>
    </form>
  </div>
`;
const $ = <T extends Element>(sel: string) => app.querySelector<T>(sel)!;
const svg = $<SVGSVGElement>('svg.graph');
const headers = $<HTMLDivElement>('.headers');
const scroller = $<HTMLDivElement>('.scroller');
const details = $<HTMLDivElement>('.details');
const popover = $<HTMLDivElement>('.popover');
const banner = $<HTMLDivElement>('.banner');
const errorBox = $<HTMLDivElement>('.error');
const ghost = $<HTMLDivElement>('.ghost');
const alignSelect = $<HTMLSelectElement>('select.align');
const mergedLanesBox = $<HTMLInputElement>('input.merged-lanes');
const modalBackdrop = $<HTMLDivElement>('.modal-backdrop');
const pushForm = $<HTMLFormElement>('form.push-dialog');

$('[data-act=refresh]').addEventListener('click', () => send({ type: 'refresh' }));
$('[data-act=more]').addEventListener('click', () => send({ type: 'loadMore' }));
alignSelect.addEventListener('change', () => {
  state.settings.alignment = alignSelect.value as Alignment;
  relayout();
  send({ type: 'setAlignment', alignment: state.settings.alignment });
});
mergedLanesBox.addEventListener('change', () => {
  state.settings.showMergedLanes = mergedLanesBox.checked;
  relayout();
  send({ type: 'setShowMergedLanes', show: mergedLanesBox.checked });
});

// ---------- Messages ----------

window.addEventListener('message', (ev: MessageEvent<HostMessage>) => {
  const m = ev.data;
  switch (m.type) {
    case 'graph': {
      state.raw = m.raw;
      state.settings = m.settings;
      state.rebase = m.rebase;
      state.merging = m.merging ?? null;
      state.repoName = m.repoName;
      state.error = undefined;
      state.selection = state.selection.filter((s) => m.raw.commits[s]);
      if (state.pinned && !m.raw.commits[state.pinned]) state.pinned = undefined;
      relayout();
      if (state.selection.length) send({ type: 'listFiles', shas: state.selection });
      else state.files = undefined;
      renderDetails();
      break;
    }
    case 'merged':
      state.merged = m.merged;
      state.chains = m.chains ?? {};
      relayout();
      break;
    case 'files':
      if (m.shas.join() === state.selection.join()) {
        state.files = { shas: m.shas, files: m.files, left: m.left, right: m.right };
        renderDetails();
      }
      break;
    case 'error':
      state.error = m.message;
      renderChrome();
      break;
    case 'busy':
      state.busy = m.busy;
      app.classList.toggle('busy', m.busy);
      break;
  }
});

// ---------- Layout + render ----------

function relayout() {
  if (!state.raw) return;
  state.layout = computeLayout(state.raw, {
    alignment: state.settings.alignment,
    expandedGaps: state.expandedGaps,
    hiddenChains: new Set(Object.keys(state.chains)),
    hideMergedLanes: !state.settings.showMergedLanes,
  });
  render();
  replacePinned();
}

const laneX = (column: number) => PAD_X + column * LANE_W + LANE_W / 2;
const rowY = (row: number) => row * ROW_H + ROW_H / 2;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

function laneColor(lane: number, kind: string): string {
  if (kind === 'trunk') return 'var(--lane-trunk)';
  return `var(--lane-${lane % 8})`;
}

function renderChrome() {
  $('.repo').textContent = state.repoName;
  alignSelect.value = state.settings.alignment;
  mergedLanesBox.checked = state.settings.showMergedLanes;
  errorBox.classList.toggle('hidden', !state.error);
  errorBox.textContent = state.error ?? '';

  // One banner for whichever operation stopped on conflicts.
  const r = state.rebase;
  const mg = state.merging;
  banner.classList.toggle('hidden', !r && !mg);
  banner.innerHTML = '';
  if (!r && !mg) return;
  const text = document.createElement('span');
  text.textContent = r
    ? `Rebase in progress${r.branch ? ` (${r.branch})` : ''}${r.step && r.total ? ` — commit ${r.step} of ${r.total}` : ''}. Resolve conflicts, stage the files, then continue.`
    : `Merge in progress${mg!.message ? ` (${mg!.message})` : ''}. Resolve conflicts, stage the files, then continue.`;
  banner.append(text);
  const steps = r
    ? ([['Continue', 'continue'], ['Skip', 'skip'], ['Abort', 'abort']] as const)
    : ([['Continue', 'continue'], ['Abort', 'abort']] as const);
  for (const [label, act] of steps) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () =>
      send(r ? { type: 'rebaseStep', step: act as 'continue' | 'skip' | 'abort' } : { type: 'mergeStep', step: act as 'continue' | 'abort' }),
    );
    banner.append(b);
  }
  const scm = document.createElement('button');
  scm.textContent = 'Open Source Control';
  scm.addEventListener('click', () => send({ type: 'openScm' }));
  banner.append(scm);
}

function render() {
  renderChrome();
  const layout = state.layout;
  const raw = state.raw;
  if (!layout || !raw) return;

  const lanesW = PAD_X * 2 + layout.columnCount * LANE_W;
  const showSubjects = state.settings.subjects === 'head';
  const msgX = lanesW + 8;
  const width = Math.max(lanesW + (showSubjects ? 480 : 200), scroller.clientWidth);
  const height = layout.rowCount * ROW_H + 8;
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.innerHTML = '';

  // Lane headers: rotated names so narrow lanes still read.
  headers.innerHTML = '';
  headers.style.width = `${width}px`;
  applyHeaderHeight();
  const labelled = new Set<number>();
  for (const lane of layout.lanes) {
    if (labelled.has(lane.column)) continue; // merged side-chains share a column and one header
    labelled.add(lane.column);
    const h = document.createElement('div');
    const onHead = lane.isHead || lane.commits.some((c) => layout.headPath.has(c));
    h.className = `lane-header${lane.isHead ? ' head' : ''}${lane.kind === 'merged' ? ' merged' : ''}${onHead ? '' : ' off'}`;
    h.style.left = `${laneX(lane.column) - 6}px`;
    if (lane.kind !== 'merged') h.style.color = laneColor(lane.index, lane.kind);
    const b = lane.branch;
    let label = lane.name ?? 'merged';
    if (lane.isHead) label = `● ${label}`;
    if (b?.worktree) label += ' ⎇';
    if (b?.upstream && b.ahead + b.behind > 0) {
      const diverged = b.ahead > 0 && b.behind > 0 && !(b.upstreamSha && layout.nodeBySha.has(b.upstreamSha));
      label += diverged ? ` (diverged ↑${b.ahead} ↓${b.behind})` : ` ↑${b.ahead} ↓${b.behind}`;
    }
    h.textContent = label;
    const mergedHere = lane.kind === 'branch' ? mergedInfo(lane.name) : undefined;
    if (mergedHere) {
      const check = document.createElement('span');
      check.className = 'merged-check';
      check.textContent = ' ✓ merged';
      h.append(check);
    }
    h.title = [
      lane.name ?? 'Commits merged from a branch that no longer exists',
      mergedHere && `${mergedText(mergedHere)} (safe to delete)`,
      b?.upstream ? `${b.untracked ? 'on remote as' : 'upstream'}: ${b.upstream}` : lane.kind === 'branch' && 'not on any remote yet (all commits unpushed)',
      b?.worktree && `checked out in worktree ${b.worktree}`,
    ]
      .filter(Boolean)
      .join('\n');
    headers.appendChild(h);
  }
  const handle = document.createElement('div');
  handle.className = 'header-resize';
  handle.title = 'Drag to resize · double-click to fit names';
  headers.appendChild(handle);
  if (showSubjects) {
    const h = document.createElement('div');
    h.className = 'msg-header';
    h.style.left = `${msgX}px`;
    h.textContent = 'HEAD history';
    headers.appendChild(h);
  }

  // Lane guide lines.
  const guides = el('g', { class: 'guides' }, svg);
  for (let c = 0; c < layout.columnCount; c++) {
    el('line', { x1: laneX(c), x2: laneX(c), y1: 0, y2: height, class: 'guide' }, guides);
  }

  // Selection / drop highlight row bands.
  const bands = el('g', { class: 'bands' }, svg);
  for (const sha of state.selection) {
    const n = layout.nodeBySha.get(sha);
    if (n) el('rect', { x: 0, y: n.row * ROW_H, width, height: ROW_H, class: 'band selected' }, bands);
  }

  // Gaps.
  for (const gap of layout.gaps) {
    const g = el('g', { class: 'gap' }, svg);
    const y = rowY(gap.row);
    el('line', { x1: laneX(0), x2: laneX(0), y1: y - ROW_H / 2, y2: y + ROW_H / 2, class: 'edge gap-line' }, g);
    const t = el('text', { x: laneX(0) + 10, y: y + 4, class: 'gap-text' }, g);
    t.textContent = `… ${gap.hidden.length} commits …`;
    g.addEventListener('click', () => {
      state.expandedGaps.add(gap.key);
      relayout();
    });
  }

  // Edges.
  const edgeLayer = el('g', { class: 'edges' }, svg);
  for (const e of layout.edges) {
    const a = layout.nodeBySha.get(e.from)!;
    const b = layout.nodeBySha.get(e.to)!;
    const x1 = laneX(a.column);
    const y1 = rowY(a.row);
    const x2 = laneX(b.column);
    const y2 = rowY(b.row);
    let d: string;
    if (e.kind === 'merge' && y2 - y1 > ROW_H * 1.2) {
      // Merge lines get their own track beside the merging lane (toward the merged commit), so they
      // never hide under that lane's solid line; they cross over in the row above the merged commit.
      const g = x1 + (x2 < x1 ? -1 : 1) * LANE_W * 0.38;
      const bendY = y2 - ROW_H;
      d = `M${x1},${y1} C${x1},${y1 + ROW_H * 0.45} ${g},${y1 + ROW_H * 0.15} ${g},${y1 + ROW_H * 0.6} L${g},${bendY} C${g},${bendY + ROW_H * 0.6} ${x2},${y2 - ROW_H * 0.6} ${x2},${y2}`;
    } else if (x1 === x2) d = `M${x1},${y1} L${x2},${y2}`;
    else {
      // Run down the child's lane, then curve across in the last row before the parent.
      const bendY = Math.max(y1, y2 - ROW_H);
      d = `M${x1},${y1} L${x1},${bendY} C${x1},${bendY + ROW_H * 0.6} ${x2},${y2 - ROW_H * 0.6} ${x2},${y2}`;
    }
    const onHead = layout.headPath.has(e.from) && layout.headPath.has(e.to);
    el(
      'path',
      { d, class: `edge ${e.kind}${onHead ? ' on-head' : ' off'}`, stroke: laneColor(a.lane, layout.lanes[a.lane].kind), 'data-from': e.from, 'data-to': e.to },
      edgeLayer,
    );
  }

  // Nodes.
  const nodeLayer = el('g', { class: 'nodes' }, svg);
  for (const n of layout.nodes) {
    const lane = layout.lanes[n.lane];
    const color = laneColor(n.lane, lane.kind);
    const g = el('g', { class: `node${layout.headPath.has(n.sha) ? ' on-head' : ' off'}`, 'data-sha': n.sha, transform: `translate(${laneX(n.column)},${rowY(n.row)})` }, nodeLayer);
    el('circle', { r: LANE_W / 2, class: 'hit' }, g);
    if (state.selection.includes(n.sha)) el('circle', { r: DOT_R + 4, class: 'sel-ring', stroke: color }, g);
    const refs = layout.refs[n.sha] ?? [];
    if (refs.some((r) => r.kind === 'remote')) el('circle', { r: DOT_R + 3, class: 'remote-ring', stroke: color }, g);
    if (n.merge) el('rect', { x: -DOT_R, y: -DOT_R, width: DOT_R * 2, height: DOT_R * 2, transform: 'rotate(45)', class: 'dot', fill: color, stroke: color }, g);
    else el('circle', { r: DOT_R, class: `dot${n.unpushed ? ' unpushed' : ''}`, fill: n.unpushed ? 'var(--bg)' : color, stroke: color }, g);
    if (n.sha === raw.head.sha) el('circle', { r: 2, class: 'head-dot' }, g);
  }

  // Message column: ref labels for the row, then HEAD's first-parent history (trunk subjects dimmed elsewhere).
  const laneNames = new Set(layout.lanes.map((l) => l.name));
  const byRow = new Map<number, LayoutNode[]>();
  for (const n of layout.nodes) byRow.set(n.row, [...(byRow.get(n.row) ?? []), n]);
  const msgs = el('g', { class: 'messages' }, svg);
  for (const [row, nodes] of byRow) {
    const head = nodes.find((n) => layout.headPath.has(n.sha));
    const pick = showSubjects ? head ?? nodes.find((n) => n.lane === 0) : undefined;
    // Branches with their own lane are named in the header; everything else is labelled here.
    const labels = nodes.flatMap((n) =>
      (layout.refs[n.sha] ?? [])
        .filter((r) => r.kind !== 'branch' || !laneNames.has(r.name))
        .map((r) => ({ ...r, color: laneColor(n.lane, layout.lanes[n.lane].kind), sha: n.sha })),
    );
    if (!pick && !labels.length) continue;
    const t = el('text', { x: msgX, y: rowY(row) + 4, class: 'msg' }, msgs);
    for (const r of labels) {
      const span = el('tspan', { class: `ref${layout.headPath.has(r.sha) ? '' : ' off'}`, fill: r.color, 'data-sha': r.sha }, t);
      span.textContent = `${r.kind === 'remote' ? '☁ ' : ''}${r.name}  `;
    }
    if (pick) {
      const span = el('tspan', { class: head ? '' : 'dim', 'data-sha': pick.sha }, t);
      span.textContent = `${pick.sha.slice(0, 7)}  ${raw.commits[pick.sha].subject}`;
    }
  }
}

// ---------- Push dialog ----------

function openPushDialog(branch: string) {
  const raw = state.raw!;
  const b = raw.branches.find((x) => x.name === branch) ?? (raw.trunk.name === branch ? raw.trunk : undefined);
  hidePopover(true);
  pushForm.querySelector('.push-branch')!.textContent = branch;
  const select = pushForm.elements.namedItem('remote') as HTMLSelectElement;
  select.innerHTML = '';
  for (const r of raw.remotes) select.add(new Option(r, r));
  select.value = b?.upstreamRemote && raw.remotes.includes(b.upstreamRemote) ? b.upstreamRemote : raw.remotes.includes('origin') ? 'origin' : raw.remotes[0];
  (pushForm.elements.namedItem('setUpstream') as HTMLInputElement).checked = true;
  (pushForm.querySelector('input[value=normal]') as HTMLInputElement).checked = true;
  pushForm.dataset.branch = branch;
  modalBackdrop.classList.remove('hidden');
  pushForm.querySelector<HTMLButtonElement>('button.primary')!.focus();
}

function closePushDialog() {
  modalBackdrop.classList.add('hidden');
}

pushForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const data = new FormData(pushForm);
  send({
    type: 'push',
    branch: pushForm.dataset.branch!,
    remote: String(data.get('remote')),
    setUpstream: data.get('setUpstream') === 'on',
    mode: data.get('mode') as PushMode,
  });
  closePushDialog();
});
pushForm.querySelector('[data-act=cancel]')!.addEventListener('click', closePushDialog);
modalBackdrop.addEventListener('mousedown', (ev) => {
  if (ev.target === modalBackdrop) closePushDialog();
});

// ---------- Header resizing ----------

function applyHeaderHeight() {
  const hgt = state.settings.headerHeight;
  headers.style.height = `${hgt}px`;
  // Rotated text rises sin(angle) px per px of length; leave a little margin.
  const maxLen = (hgt - 10) / Math.sin((LABEL_ANGLE * Math.PI) / 180);
  headers.style.setProperty('--label-max', `${Math.max(20, maxLen)}px`);
}

let headerDrag: { startY: number; startH: number } | undefined;
headers.addEventListener('pointerdown', (ev) => {
  if (!(ev.target as Element).classList.contains('header-resize')) return;
  headerDrag = { startY: ev.clientY, startH: state.settings.headerHeight };
  headers.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});
headers.addEventListener('pointermove', (ev) => {
  if (!headerDrag) return;
  const h = headerDrag.startH + ev.clientY - headerDrag.startY;
  state.settings.headerHeight = Math.round(Math.min(HEADER_MAX, Math.max(HEADER_MIN, h)));
  applyHeaderHeight();
});
headers.addEventListener('pointerup', () => {
  if (!headerDrag) return;
  headerDrag = undefined;
  send({ type: 'setHeaderHeight', height: state.settings.headerHeight });
});
headers.addEventListener('dblclick', (ev) => {
  if (!(ev.target as Element).classList.contains('header-resize')) return;
  // Fit the longest name: measure unclipped text widths.
  let longest = 0;
  headers.querySelectorAll<HTMLElement>('.lane-header').forEach((h) => {
    const prev = h.style.maxWidth;
    h.style.maxWidth = 'none';
    longest = Math.max(longest, h.scrollWidth);
    h.style.maxWidth = prev;
  });
  const fit = Math.ceil(longest * Math.sin((LABEL_ANGLE * Math.PI) / 180) + 16);
  state.settings.headerHeight = Math.min(HEADER_MAX, Math.max(HEADER_MIN, fit));
  applyHeaderHeight();
  send({ type: 'setHeaderHeight', height: state.settings.headerHeight });
});

// ---------- Details pane ----------

function renderDetails() {
  const raw = state.raw;
  if (!raw || state.selection.length === 0) {
    details.classList.add('hidden');
    return;
  }
  details.classList.remove('hidden');
  details.innerHTML = '';
  const sel = state.selection;
  const head = document.createElement('div');
  head.className = 'details-head';
  if (sel.length === 1) {
    const c = raw.commits[sel[0]];
    head.innerHTML = `<div class="subject"></div><div class="meta"></div>`;
    head.querySelector('.subject')!.textContent = c.subject;
    head.querySelector('.meta')!.textContent = `${c.sha.slice(0, 10)} · ${c.author} · ${new Date(c.date * 1000).toLocaleString()}`;
  } else {
    head.innerHTML = `<div class="subject">Compare</div><div class="meta"></div>`;
    // Selection is in click order: the second commit is the base, the first is applied onto it.
    const [base, applied] = [sel[1], sel[0]];
    head.querySelector('.meta')!.textContent = `${base.slice(0, 7)} → ${applied.slice(0, 7)}  (applying ${applied.slice(0, 7)} onto ${base.slice(0, 7)})`;
  }
  const actions = document.createElement('div');
  actions.className = 'details-actions';
  const openAllBtn = document.createElement('button');
  openAllBtn.textContent = 'Open all changes';
  openAllBtn.addEventListener('click', () => send({ type: 'openAll', shas: sel }));
  const close = document.createElement('button');
  close.textContent = '✕';
  close.title = 'Clear selection';
  close.addEventListener('click', () => select([]));
  actions.append(openAllBtn, close);
  head.append(actions);
  details.append(head);
  if (state.files?.files.length) {
    const total = { added: 0, deleted: 0, modified: 0, binary: false };
    for (const f of state.files.files) {
      total.added += f.stats?.added ?? 0;
      total.deleted += f.stats?.deleted ?? 0;
      total.modified += f.stats?.modified ?? 0;
    }
    const summary = document.createElement('div');
    summary.className = 'details-summary';
    summary.textContent = `${state.files.files.length} file${state.files.files.length === 1 ? '' : 's'}`;
    summary.append(statsEl(total));
    details.append(summary);
  }

  const list = document.createElement('ul');
  list.className = 'files';
  if (!state.files) list.innerHTML = '<li class="muted">Loading…</li>';
  else if (state.files.files.length === 0) list.innerHTML = '<li class="muted">No file changes</li>';
  else
    for (const f of state.files.files) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="status s-${f.status}"></span><span class="folder"></span><span class="name"></span>`;
      li.querySelector('.status')!.textContent = f.status;
      const slash = f.path.lastIndexOf('/');
      // Folder is shown right-to-left so a long one is shortened from the left; LRM marks keep the
      // slashes where they belong.
      li.querySelector('.folder')!.textContent = slash >= 0 ? `\u200e${f.path.slice(0, slash + 1)}\u200e` : '';
      const name = li.querySelector('.name')!;
      name.textContent = f.path.slice(slash + 1);
      if (f.oldPath) {
        const old = document.createElement('span');
        old.className = 'old-path';
        old.textContent = ` ← ${f.oldPath}`;
        name.append(old);
      }
      const st = f.stats ? statsEl(f.stats) : document.createElement('span');
      st.classList.add('line-stats', 'col');
      li.querySelector('.status')!.after(st);
      li.title = `${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}\nClick to open diff`;
      li.addEventListener('click', () => send({ type: 'openDiff', shas: sel, file: f }));
      list.append(li);
    }
  details.append(list);
  replacePinned();
}

/** "+12 ~3 −4" with zero parts omitted. */
function statsEl(st: LineStats): HTMLElement {
  const span = document.createElement('span');
  span.className = 'line-stats';
  if (st.binary) {
    span.textContent = 'binary';
    return span;
  }
  const parts: [string, number, string][] = [
    ['add', st.added, `+${st.added}`],
    ['mod', st.modified, `~${st.modified}`],
    ['del', st.deleted, `−${st.deleted}`],
  ];
  for (const [cls, n, text] of parts) {
    if (!n) continue;
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    span.append(s);
  }
  span.title = `${st.added} added · ${st.modified} modified · ${st.deleted} deleted`;
  if (!span.childElementCount) span.textContent = 'no line changes';
  return span;
}

function select(shas: string[]) {
  state.selection = shas;
  state.files = undefined;
  if (shas.length) send({ type: 'listFiles', shas });
  render();
  renderDetails();
}

// ---------- Popover ----------

function relTime(unix: number): string {
  const s = Date.now() / 1000 - unix;
  const units: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [secs, name] of units) if (s >= secs) return `${Math.floor(s / secs)} ${name}${Math.floor(s / secs) > 1 ? 's' : ''} ago`;
  return 'just now';
}

function showPopover(sha: string, anchor: Element, pinned: boolean, mouse?: Point) {
  const raw = state.raw!;
  const c = raw.commits[sha];
  const refs = state.layout?.refs[sha] ?? [];
  popover.innerHTML = '';
  popover.classList.toggle('pinned', pinned);
  const add = (cls: string, text: string, tag = 'div') => {
    const d = document.createElement(tag);
    d.className = cls;
    d.textContent = text;
    popover.append(d);
    return d;
  };
  const worktrees = new Map(raw.branches.filter((b) => b.worktree).map((b) => [b.name, b.worktree!]));
  const refNames = refs.map((r) => (worktrees.has(r.name) ? `${r.name} ⎇` : r.name));
  add('pop-sha', `${sha === raw.head.sha ? 'HEAD → ' : ''}${sha.slice(0, 10)}${refNames.length ? '  ' + refNames.join(', ') : ''}`);
  add('pop-subject', c.subject);
  // Worktrees for the branch this commit is on, and for any branch pointing at it.
  const node = state.layout?.nodeBySha.get(sha);
  const laneBranch = node ? state.layout!.lanes[node.lane].name : undefined;
  const wtBranches = new Set([laneBranch, ...refs.map((r) => r.name)].filter((n): n is string => !!n && worktrees.has(n)));
  for (const name of wtBranches) {
    add('pop-worktree', `⎇ ${name} is checked out in worktree ${worktrees.get(name)}`);
  }
  // For merge commits: what each extra parent brought in, and where it sits in the graph.
  for (const p of c.parents.slice(1)) {
    const at = state.layout?.nodeBySha.get(p);
    const where = at ? state.layout!.lanes[at.lane].name ?? 'merged lane' : undefined;
    const pc = raw.commits[p];
    add('pop-mergeof', `⤶ Merges in ${p.slice(0, 7)}${where ? ` (${where})` : ''}${pc ? ` "${pc.subject}"` : ''}`);
  }
  const mergedLane = mergedInfo(laneBranch);
  if (mergedLane) add('pop-merged', `✓ ${laneBranch}: ${mergedText(mergedLane)}`);
  const folded = state.layout?.foldedMerges[sha];
  if (folded) {
    const n = state.layout!.foldedSizes[folded] ?? 0;
    const what = `${n} commit${n === 1 ? '' : 's'}, newest ${folded.slice(0, 7)} "${raw.commits[folded]?.subject ?? ''}"`;
    if (state.chains[folded]) {
      add('pop-merged', `✓ Merged in ${what}, already on ${raw.trunk.name} (${mergedText(state.chains[folded]).toLowerCase()})`);
    } else {
      add('pop-folded', `Merged in ${what} (lane hidden: Merged lanes is off)`);
    }
  }
  if (c.body) add('pop-body', c.body);
  add('pop-meta', `${c.author} <${c.email}>`);
  add('pop-meta', `${relTime(c.date)} · ${new Date(c.date * 1000).toLocaleString()}`);
  if (pinned) {
    const button = (parent: HTMLElement, label: string, fn: () => void, cls?: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      parent.append(b);
      return b;
    };
    const branchRefs = refs.filter((r) => r.kind === 'branch');
    const local = new Set(raw.branches.filter((b) => !b.detached).map((b) => b.name));
    if (!raw.trunk.remote) local.add(raw.trunk.name);
    const tipOf = (name: string) => (name === raw.trunk.name ? raw.trunk.tip : raw.branches.find((b) => b.name === name)?.tip);
    // Local branches whose tip this is, then the branch whose lane it's on.
    const tips = branchRefs.map((r) => r.name).filter((n) => local.has(n) && tipOf(n) === sha);
    const branchesHere = [...new Set([...tips, ...(laneBranch && local.has(laneBranch) ? [laneBranch] : [])])];
    const current = raw.head.branch;

    // Commit-level actions.
    const actions = add('pop-actions', '');
    button(actions, 'Copy SHA', () => send({ type: 'copy', text: sha }));
    // Detaching is only offered for commits that aren't a branch tip, and labelled as such.
    if (!tips.length && !(sha === raw.head.sha && !current)) {
      button(actions, 'Checkout this commit (detached)', () => send({ type: 'checkout', ref: sha }));
    }

    // One row of actions per branch: name: [Checkout] [Push] [Merge into current] [Delete]
    const rows = add('pop-branches', '');
    const row = (name: string, color?: string) => {
      const r = document.createElement('div');
      r.className = 'pop-branch-row';
      const label = document.createElement('span');
      label.className = 'pop-branch-name';
      label.textContent = `${name}:`;
      if (color) label.style.color = color;
      const buttons = document.createElement('span');
      buttons.className = 'pop-branch-buttons';
      r.append(label, buttons);
      rows.append(r);
      return buttons;
    };
    for (const name of branchesHere) {
      const laneIdx = state.layout?.lanes.findIndex((l) => l.name === name) ?? -1;
      const r = row(name, laneIdx >= 0 ? laneColor(laneIdx, state.layout!.lanes[laneIdx].kind) : undefined);
      if (name === current) {
        const on = document.createElement('span');
        on.className = 'pop-current';
        on.textContent = '✓ checked out';
        r.append(on);
      } else {
        const atTip = tips.includes(name);
        button(r, 'Checkout', () => send({ type: 'checkout', ref: name })).title = atTip
          ? `Check out ${name}`
          : `Check out ${name} (at its tip, not this commit)`;
      }
      if (raw.remotes.length) button(r, 'Push', () => openPushDialog(name));
      if (current && name !== current) {
        button(r, 'Merge into current', () => send({ type: 'merge', ref: name })).title = `Merge ${name} into ${current}`;
      }
      if (name !== current) button(r, 'Delete', () => send({ type: 'deleteBranch', branch: name }), 'danger');
    }
    // The remote trunk (e.g. origin/main) at its tip: offer to bring it into the current branch.
    if (raw.trunk.remote && sha === raw.trunk.tip && current) {
      const r = row(raw.trunk.name, laneColor(0, 'trunk'));
      button(r, 'Merge into current', () => send({ type: 'merge', ref: raw.trunk.name })).title = `Merge ${raw.trunk.name} into ${current}`;
    }
    if (!rows.childElementCount) rows.remove();
    // Warm up the server check a delete dialog would need, so it opens without waiting on the network.
    const deletableHere = branchesHere.filter((n) => n !== current);
    if (deletableHere.length && raw.remotes.length) send({ type: 'probeRemote', branches: deletableHere });
  }
  popover.classList.remove('hidden');
  hoverAnchor = pinned ? undefined : anchor;
  placePopover(anchor, mouse);
}

/** The commit the (unpinned) hover popover belongs to, so it can follow the pointer. */
let hoverAnchor: Element | undefined;

/** Positions the popover beside its commit, inside the graph area so it never covers the details pane. */
type Point = { x: number; y: number };
const MIN_POPOVER_W = 220;

/**
 * Positions the popover inside the graph area (never over the details pane) so it covers neither
 * its commit nor the mouse pointer: beside them if there's room, otherwise below or above.
 */
function placePopover(anchor: Element, mouse?: Point) {
  const r = anchor.getBoundingClientRect();
  const area = scroller.getBoundingClientRect();
  const top = area.top + 4;
  const bottom = (details.classList.contains('hidden') ? window.innerHeight : details.getBoundingClientRect().top) - 4;
  const right = window.innerWidth - 4;
  // If even the whole graph area is too short, cap the height and let it scroll.
  popover.style.maxHeight = `${Math.max(80, bottom - top)}px`;
  popover.style.maxWidth = ''; // back to the stylesheet's width before measuring
  const pw = popover.offsetWidth;
  const ph = popover.offsetHeight;

  // The region to keep clear: the commit, plus the pointer with a little margin around it.
  const gap = 10;
  const avoid = {
    left: Math.min(r.left, mouse ? mouse.x - gap : r.left),
    right: Math.max(r.right, mouse ? mouse.x + gap : r.right),
    top: Math.min(r.top, mouse ? mouse.y - gap : r.top),
    bottom: Math.max(r.bottom, mouse ? mouse.y + gap : r.bottom),
  };
  const clampY = (h: number, y: number) => Math.max(top, Math.min(y, bottom - h));
  const cx = mouse?.x ?? (r.left + r.right) / 2;
  const roomRight = right - (avoid.right + 8);
  const roomLeft = avoid.left - 8 - 4;
  /** Narrows the popover to `w` px (text wraps) and returns its new size. */
  const fitWidth = (w: number) => {
    popover.style.maxWidth = `${Math.floor(w)}px`;
    return [popover.offsetWidth, popover.offsetHeight];
  };
  let x: number;
  let y: number;
  if (pw <= roomRight) {
    [x, y] = [avoid.right + 8, clampY(ph, avoid.top - 8)]; // beside, to the right
  } else if (pw <= roomLeft) {
    [x, y] = [avoid.left - 8 - pw, clampY(ph, avoid.top - 8)]; // beside, to the left
  } else if (avoid.bottom + 8 + ph <= bottom) {
    [x, y] = [Math.max(4, Math.min(cx - pw / 2, right - pw)), avoid.bottom + 8]; // below
  } else if (avoid.top - 8 - ph >= top) {
    [x, y] = [Math.max(4, Math.min(cx - pw / 2, right - pw)), avoid.top - 8 - ph]; // above
  } else if (Math.max(roomRight, roomLeft) >= MIN_POPOVER_W) {
    // Squeeze it beside the commit on the roomier side; it wraps and gets taller instead of overlapping.
    const toRight = roomRight >= roomLeft;
    const [w, h] = fitWidth(toRight ? roomRight : roomLeft);
    [x, y] = [toRight ? avoid.right + 8 : avoid.left - 8 - w, clampY(h, avoid.top - 8)];
  } else {
    // Last resort (very wide commit): keep clear of just the pointer.
    const px = mouse?.x ?? cx;
    const toRight = right - px >= px;
    const [w, h] = fitWidth(Math.max(MIN_POPOVER_W, toRight ? right - px - gap : px - gap - 4));
    [x, y] = [toRight ? px + gap : Math.max(4, px - gap - w), clampY(h, avoid.top - 8)];
  }
  popover.style.left = `${x}px`;
  popover.style.top = `${y}px`;
}

/** Which element the pinned popover belongs to: the commit's dot, or its line in the message column. */
let pinnedVia: 'node' | 'msg' = 'node';
const anchorFor = (sha: string, via: 'node' | 'msg') =>
  (via === 'msg' && svg.querySelector(`text.msg tspan[data-sha="${sha}"]:not(.ref)`)) || svg.querySelector(`g.node[data-sha="${sha}"]`);

/** Re-places the pinned popover after the layout around it changes (details pane resized, scrolling). */
function replacePinned() {
  if (!state.pinned || popover.classList.contains('hidden')) return;
  const anchor = anchorFor(state.pinned, pinnedVia);
  if (anchor) placePopover(anchor);
}

function hidePopover(force = false) {
  if (state.pinned && !force) return;
  if (force) state.pinned = undefined;
  popover.classList.add('hidden');
}

const shaAt = (target: EventTarget | null) => (target as Element | null)?.closest?.('[data-sha]')?.getAttribute('data-sha') ?? undefined;

function highlightMerges(sha: string | undefined) {
  svg.querySelectorAll('.hl').forEach((n) => n.classList.remove('hl'));
  if (!sha) return;
  svg.querySelectorAll(`path.edge.merge[data-from="${sha}"]`).forEach((p) => {
    p.classList.add('hl');
    svg.querySelector(`g.node[data-sha="${p.getAttribute('data-to')}"]`)?.classList.add('hl');
  });
}

svg.addEventListener('mouseover', (ev) => {
  if (drag) return;
  const sha = shaAt(ev.target);
  highlightMerges(sha);
  if (sha && !state.pinned) showPopover(sha, (ev.target as Element).closest('[data-sha]')!, false, { x: ev.clientX, y: ev.clientY });
});
svg.addEventListener('mousemove', (ev) => {
  // Keep the hover popover clear of the pointer as it moves within a commit.
  if (!drag && !state.pinned && hoverAnchor && !popover.classList.contains('hidden')) {
    placePopover(hoverAnchor, { x: ev.clientX, y: ev.clientY });
  }
});
svg.addEventListener('mouseout', (ev) => {
  if (!shaAt(ev.relatedTarget)) {
    hidePopover();
    highlightMerges(undefined);
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!modalBackdrop.classList.contains('hidden')) return closePushDialog();
  // During a drag, Escape only cancels the drag; otherwise it closes the popover and details pane.
  if (drag?.active) return cancelDrag();
  cancelDrag();
  hidePopover(true);
  if (state.selection.length) select([]);
});
document.addEventListener('mousedown', (ev) => {
  if (state.pinned && !popover.contains(ev.target as Node) && !shaAt(ev.target)) hidePopover(true);
});

// ---------- Click, compare, drag-to-rebase ----------

interface Drag {
  sha: string;
  lane: number;
  startX: number;
  startY: number;
  active: boolean;
  invalid: Set<string>;
  over?: string;
  /** Whether the press was on the commit's dot or its message-column line. */
  via: 'node' | 'msg';
}
let drag: Drag | undefined;
const DOUBLE_CLICK_MS = 400;
let lastClick: { sha: string; time: number } | undefined;

svg.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || state.busy) return;
  const sha = shaAt(ev.target);
  if (!sha || !state.layout) return;
  const lane = draggableLane(state.layout, sha);
  const via = (ev.target as Element).closest('text.msg') ? 'msg' : 'node';
  drag = { sha, lane: lane ?? -1, startX: ev.clientX, startY: ev.clientY, active: false, invalid: new Set(), via };
  svg.setPointerCapture(ev.pointerId);
});

svg.addEventListener('pointermove', (ev) => {
  if (!drag || !state.layout) return;
  if (!drag.active) {
    if (drag.lane < 0 || state.rebase || Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 6) return;
    drag.active = true;
    drag.invalid = invalidTargets(state.layout, drag.lane);
    hidePopover(true);
    app.classList.add('dragging');
    const lane = state.layout.lanes[drag.lane];
    ghost.textContent = `${lane.name} (${lane.commits.length} commit${lane.commits.length === 1 ? '' : 's'})`;
    ghost.classList.remove('hidden');
    for (const n of state.layout.nodes) {
      const g = svg.querySelector(`[data-sha="${n.sha}"]`);
      g?.classList.toggle('drop-ok', !drag.invalid.has(n.sha));
      g?.classList.toggle('drag-src', lane.commits.includes(n.sha));
    }
  }
  ghost.style.left = `${ev.clientX + 12}px`;
  ghost.style.top = `${ev.clientY + 12}px`;
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const over = shaAt(el);
  const valid = over && !drag.invalid.has(over) ? over : undefined;
  if (valid !== drag.over) {
    if (drag.over) svg.querySelector(`[data-sha="${drag.over}"]`)?.classList.remove('drop-hover');
    if (valid) svg.querySelector(`[data-sha="${valid}"]`)?.classList.add('drop-hover');
    drag.over = valid;
  }
});

svg.addEventListener('pointerup', (ev) => {
  if (!drag) return;
  const d = drag;
  cancelDrag();
  if (d.active) {
    const lane = state.layout!.lanes[d.lane];
    if (d.over && lane.name) send({ type: 'rebase', branch: lane.name, target: d.over });
    return;
  }
  // Plain click.
  const prevClick = lastClick;
  lastClick = { sha: d.sha, time: ev.timeStamp };
  if (ev.ctrlKey || ev.metaKey) {
    hidePopover(true);
    const prev = state.selection.filter((s) => s !== d.sha);
    // Ctrl/⌘-clicking a selected commit removes it from the comparison.
    if (state.selection.includes(d.sha)) return select(prev);
    // Click order matters: [first, second]; the diff applies the first onto the second.
    select(prev.length ? [prev[prev.length - 1], d.sha] : [d.sha]);
  } else if (prevClick && prevClick.sha === d.sha && ev.timeStamp - prevClick.time < DOUBLE_CLICK_MS) {
    // Double-click: check it out. The first click already selected it, so leave that open.
    lastClick = undefined;
    send({ type: 'checkout', ref: checkoutTarget(state.raw!, state.layout!, d.sha) });
    return;
  } else if (state.selection.length === 1 && state.selection[0] === d.sha) {
    // Clicking the selected commit again closes its popover and details.
    hidePopover(true);
    select([]);
  } else {
    select([d.sha]);
    state.pinned = d.sha;
    pinnedVia = d.via;
    const anchor = anchorFor(d.sha, d.via);
    if (anchor) showPopover(d.sha, anchor, true, { x: ev.clientX, y: ev.clientY });
  }
});

svg.addEventListener('pointercancel', () => cancelDrag());

function cancelDrag() {
  if (!drag) return;
  drag = undefined;
  app.classList.remove('dragging');
  ghost.classList.add('hidden');
  svg.querySelectorAll('.drop-ok, .drop-hover, .drag-src').forEach((n) => n.classList.remove('drop-ok', 'drop-hover', 'drag-src'));
}

window.addEventListener('resize', () => {
  render();
  replacePinned();
});
scroller.addEventListener('scroll', () => {
  replacePinned();
  if (!state.pinned) hidePopover();
});
send({ type: 'ready' });
