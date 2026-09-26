/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVibezQueueService, IVibezQueueState, IVibezQueueResult } from '../../../../platform/vibez/common/vibezQueueService.js';
import { claimText, isLive, Lane, ms, percent, stateText } from '../../../../platform/vibez/common/vibezQueue.js';
import { canvasSelection } from './vibezCanvasSelection.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * The queue strip: one row per agent, under the canvas.
 *
 *   a  getUserStats        edited · queued 2nd      claims −87%
 *   b  StatsGrid           measuring ⟳  run 12/20
 *   c  lib/api/fetch.ts    editing
 *
 * Three states and no more: editing, queued, measuring. A finished run becomes
 * a card with its claimed change and, once others have landed, its measured
 * one. Landing is a person's choice, one patch at a time.
 */
export class VibezQueueView extends ViewPane {

	static readonly ID = 'workbench.view.vibez.queue';

	private root!: HTMLElement;
	private status!: HTMLElement;
	private rows!: HTMLElement;
	private input!: HTMLInputElement;
	private scope!: HTMLElement;
	private startButton!: HTMLButtonElement;
	private state: IVibezQueueState | undefined;
	private busy = false;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IVibezQueueService private readonly queue: IVibezQueueService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService,
			viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.root = dom.append(container, dom.$('.vibez-queue'));
		const style = dom.append(this.root, dom.$('style'));
		style.textContent = QUEUE_CSS;

		const composer = dom.append(this.root, dom.$('.vq-compose'));
		this.input = dom.append(composer, dom.$<HTMLInputElement>('input.vq-ask'));
		this.input.type = 'text';
		this.input.placeholder = localize('vibez.queue.ask', "Ask an agent… it works on the nodes selected on the canvas");
		this.input.spellcheck = false;
		this.startButton = dom.append(composer, dom.$<HTMLButtonElement>('button.vq-primary'));
		this.startButton.textContent = localize('vibez.queue.start', "Start agent");
		this.scope = dom.append(this.root, dom.$('.vq-scope'));
		this.status = dom.append(this.root, dom.$('.vq-status'));
		this.rows = dom.append(this.root, dom.$('.vq-rows'));

		this._register(dom.addDisposableListener(this.startButton, 'click', () => void this.start()));
		this._register(dom.addDisposableListener(this.input, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.isComposing) {
				e.preventDefault();
				void this.start();
			}
		}));
		this._register(canvasSelection.onDidChange(() => this.renderScope()));
		this._register(this.queue.onDidChange(state => { this.state = state; this.renderQueue(); }));

		const folder = this.contextService.getWorkspace().folders[0];
		if (folder?.uri.scheme === 'file') {
			this.queue.open(folder.uri.fsPath).then(state => { this.state = state; this.renderQueue(); }, error => this.fail(String(error)));
		}
		this.renderScope();
		this.renderQueue();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.root.style.height = `${height}px`;
	}

	private renderScope(): void {
		const nodes = canvasSelection.get();
		if (!nodes.length) {
			this.scope.textContent = localize('vibez.queue.noScope', "No nodes selected: the agent may edit any file nobody else holds.");
			return;
		}
		const files = [...new Set(nodes.map(n => n.file).filter((f): f is string => !!f))];
		this.scope.textContent = `${nodes.map(n => n.label).join(', ')} · fenced to ${files.length ? files.join(', ') : 'no files (not traced to source)'}`;
	}

	private async start(): Promise<void> {
		const ask = this.input.value.trim();
		if (!ask || this.busy) {
			return;
		}
		const nodes = canvasSelection.get();
		this.busy = true;
		this.startButton.disabled = true;
		try {
			const result = await this.queue.start({
				ask,
				fence: [...new Set(nodes.map(n => n.file).filter((f): f is string => !!f))],
				focus: nodes.map(n => n.id),
				labels: Object.fromEntries(nodes.map(n => [n.id, n.label])),
				nodes: nodes.map(n => ({ label: n.label, file: n.file, line: n.line, ms: n.ms, facts: n.facts })),
			});
			if (result.ok) {
				this.input.value = '';
			} else {
				this.fail(result.reason);
			}
		} finally {
			this.busy = false;
			this.startButton.disabled = false;
		}
	}

	private fail(reason: string | undefined): void {
		if (reason) {
			this.notifications.notify({ severity: Severity.Warning, message: reason });
		}
	}

	private act(run: () => Promise<IVibezQueueResult>): void {
		run().then(result => { if (!result.ok) { this.fail(result.reason); } }, error => this.fail(String(error)));
	}

	private button(parent: HTMLElement, label: string, title: string, run: () => void, primary = false): HTMLButtonElement {
		const b = dom.append(parent, dom.$<HTMLButtonElement>(primary ? 'button.vq-primary' : 'button.vq-button'));
		b.textContent = label;
		b.title = title;
		b.addEventListener('click', e => { e.stopPropagation(); run(); });
		return b;
	}

	private renderQueue(): void {
		if (!this.rows) {
			return;
		}
		const state = this.state;
		dom.clearNode(this.status);
		dom.clearNode(this.rows);
		if (!state) {
			this.status.textContent = localize('vibez.queue.loading', "Opening the queue…");
			return;
		}
		if (!state.root) {
			this.status.textContent = state.setup.reason ?? localize('vibez.queue.noRepo', "Open a folder in a git repository.");
			return;
		}

		// Whether agents can run at all, on its own line so it never hides the baseline.
		if (!state.agent.ok) {
			const warn = dom.append(this.status, dom.$('.vq-line'));
			const note = dom.append(warn, dom.$('span.vq-text.vq-warn'));
			note.textContent = state.agent.reason ?? '';
			this.button(warn, 'Check again', 'Look for Claude Code again, after installing it', () => {
				const folder = this.contextService.getWorkspace().folders[0];
				if (folder) {
					this.queue.open(folder.uri.fsPath).then(next => { this.state = next; this.renderQueue(); }, error => this.fail(String(error)));
				}
			});
		}

		// The status line: can measuring run, and what is the baseline.
		const line = dom.append(this.status, dom.$('.vq-line'));
		const text = dom.append(line, dom.$('span.vq-text'));
		if (!state.setup.ok) {
			text.textContent = state.setup.reason ?? '';
			text.classList.add('vq-warn');
			if (!state.setup.config) {
				this.button(line, localize('vibez.queue.setup', "Set up measuring"), 'Writes .vibez/measure.json with a first guess at how to start the app', () => this.act(async () => {
					const result = await this.queue.setupMeasuring();
					if (result.ok) {
						await this.editorService.openEditor({ resource: URI.file(`${state.root}/.vibez/measure.json`), options: { pinned: true } });
					}
					return result;
				}));
			} else {
				this.button(line, localize('vibez.queue.retry', "Measure again"), 'Measure the current commit', () => this.act(() => this.queue.measureBaseline()));
			}
		} else if (state.measuring === 'baseline') {
			text.textContent = `measuring your tree ⟳ ${state.baselineDetail ?? ''}`;
		} else if (state.baseline) {
			text.textContent = `baseline ${ms(state.baseline.flowMs)} · ${state.baseline.runs} runs · ${state.baseline.rev.slice(0, 7)}`;
		} else {
			text.textContent = localize('vibez.queue.noBaseline', "Not measured yet. Patches are measured against your current commit.");
		}
		if (state.setup.ok) {
			const flow = state.setup.recorded ? `${state.setup.recorded}-step flow` : `opens ${state.setup.config?.path ?? '/'}`;
			if (state.recording) {
				this.button(line, 'Finish recording', 'Save what you did in the recording window as the flow to measure', () => this.act(() => this.queue.stopRecording()), true);
			} else {
				this.button(line, 'Record flow', `What gets replayed to measure: ${flow}. Opens your app in a window; do what a person would do, then press Finish recording.`, () => this.act(() => this.queue.record()));
			}
			if (!state.measuring) {
				this.button(line, 'Measure', 'Measure the current commit now', () => this.act(() => this.queue.measureBaseline()));
			}
		}
		const running = state.lanes.some(l => l.state === 'editing' || l.state === 'measuring') || !!state.measuring;
		const stop = this.button(line, 'Stop all', 'Ends every agent run and measurement, and releases every fence (⌥⌘.)', () => void this.queue.stopAll());
		stop.disabled = !running;

		if (!state.lanes.length) {
			const empty = dom.append(this.rows, dom.$('.vq-empty'));
			empty.textContent = localize('vibez.queue.empty', "Select nodes on the canvas, then ask an agent. Several can work at once, each in its own copy of the repository; one measures at a time.");
			return;
		}
		const lanes = [...state.lanes].sort((a, b) => Number(isLive(b)) - Number(isLive(a)));
		for (const lane of lanes) {
			this.renderLane(lane, state);
		}
	}

	private renderLane(lane: Lane, state: IVibezQueueState): void {
		const row = dom.append(this.rows, dom.$(`.vq-row.vq-${lane.state}`));
		row.style.setProperty('--hue', String(lane.actor.hue));
		const letter = dom.append(row, dom.$('span.vq-letter'));
		letter.textContent = lane.id;
		letter.title = `${lane.actor.name} · ${lane.prompt}`;

		const target = dom.append(row, dom.$('span.vq-target'));
		target.textContent = lane.title;
		target.title = `${lane.prompt}${lane.fence.length ? `\nfenced: ${lane.fence.join(', ')}` : ''}${lane.files.length ? `\nchanged: ${lane.files.join(', ')}` : ''}${lane.summary ? `\n${lane.summary}` : ''}`;

		const what = dom.append(row, dom.$('span.vq-state'));
		what.textContent = stateText(lane, state.lanes);
		if (lane.state === 'failed') {
			what.classList.add('vq-warn');
		}

		const claim = dom.append(row, dom.$('span.vq-claim'));
		claim.textContent = claimText(lane);
		const survived = lane.measured ? (lane.measured.significant && Math.sign(lane.measured.change) === Math.sign(lane.claimed?.change ?? 0)) : undefined;
		if (survived === false) {
			claim.classList.add('vq-faded');
		}
		if (lane.claimed) {
			const d = lane.measured ?? lane.claimed;
			claim.title = `${d.subject}: ${ms(d.before)} → ${ms(d.after)} (${percent(d.change)}, p = ${d.p.toPrecision(2)})${d.changed.length ? `\nchanged: ${d.changed.slice(0, 5).map(c => `${c.id} ${percent(c.change)}`).join(', ')}` : ''}`;
		}

		const actions = dom.append(row, dom.$('span.vq-actions'));
		if (lane.files.length || lane.commit) {
			this.button(actions, 'Diff', 'Show the patch', () => void this.showDiff(lane));
		}
		if (lane.state === 'ready') {
			this.button(actions, 'Land', 'Apply this patch to your tree as one commit, then re-measure the rest', () => this.act(() => this.queue.land(lane.id)), true);
		}
		if (lane.state === 'landed') {
			this.button(actions, 'Undo', 'Take this patch back out with a revert commit', () => this.act(() => this.queue.undoLand(lane.id)));
		} else {
			this.button(actions, lane.state === 'editing' || lane.state === 'measuring' ? 'Stop' : 'Discard', 'Stop it and throw its copy away', () => this.act(() => this.queue.discard(lane.id)));
		}
	}

	private async showDiff(lane: Lane): Promise<void> {
		const text = await this.queue.diff(lane.id);
		await this.editorService.openEditor({
			resource: undefined,
			contents: text || '(no changes yet)',
			languageId: 'diff',
			options: { pinned: false },
		});
	}
}

const QUEUE_CSS = `
.vibez-queue{display:flex;flex-direction:column;gap:6px;padding:6px 12px 10px;box-sizing:border-box;overflow:auto;font-size:12px}
.vibez-queue .vq-compose{display:flex;gap:6px}
.vibez-queue .vq-ask{flex:1;min-width:0;padding:5px 8px;border-radius:4px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}
.vibez-queue .vq-ask:focus{outline:1px solid var(--vscode-focusBorder)}
.vibez-queue button{font:inherit;border-radius:4px;padding:3px 10px;cursor:pointer;border:1px solid transparent;white-space:nowrap}
.vibez-queue .vq-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.vibez-queue .vq-primary:hover{background:var(--vscode-button-hoverBackground)}
.vibez-queue .vq-button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.vibez-queue .vq-button:hover{background:var(--vscode-button-secondaryHoverBackground)}
.vibez-queue button:disabled{opacity:.5;cursor:default}
.vibez-queue .vq-scope{color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vibez-queue .vq-status{display:flex;flex-direction:column;gap:4px}
.vibez-queue .vq-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.vibez-queue .vq-text{flex:1;min-width:200px;color:var(--vscode-descriptionForeground)}
.vibez-queue .vq-warn{color:var(--vscode-editorWarning-foreground)}
.vibez-queue .vq-rows{display:flex;flex-direction:column;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));border-radius:6px;overflow:hidden}
.vibez-queue .vq-empty{padding:10px 12px;color:var(--vscode-descriptionForeground)}
.vibez-queue .vq-row{display:grid;grid-template-columns:22px minmax(120px,1.2fr) minmax(160px,1.3fr) minmax(140px,1.4fr) auto;gap:10px;align-items:center;padding:5px 10px;border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));font-family:var(--vscode-editor-font-family);font-size:12px}
.vibez-queue .vq-row:first-child{border-top:0}
.vibez-queue .vq-letter{display:grid;place-items:center;width:18px;height:18px;border-radius:50%;box-shadow:0 0 0 2px hsl(var(--hue) 70% 58%);color:hsl(var(--hue) 70% 70%);font-weight:700}
.vibez-queue .vq-target,.vibez-queue .vq-state,.vibez-queue .vq-claim{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vibez-queue .vq-state{color:var(--vscode-descriptionForeground)}
.vibez-queue .vq-measuring .vq-state{color:hsl(var(--hue) 70% 68%)}
.vibez-queue .vq-claim{text-align:right}
.vibez-queue .vq-faded{opacity:.6}
.vibez-queue .vq-actions{display:flex;gap:4px;justify-content:flex-end}
.vibez-queue .vq-landed,.vibez-queue .vq-stopped,.vibez-queue .vq-failed{opacity:.75}
`;
