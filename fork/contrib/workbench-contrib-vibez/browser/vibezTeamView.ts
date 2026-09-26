/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vibez. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
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
import { IVibezTeamResult, IVibezTeamService, IVibezTeamState, teamPath } from '../../../../platform/vibez/common/vibezTeamService.js';

const NOTE_KINDS = ['note', 'decision', 'gotcha', 'convention'];

function ago(iso: string): string {
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) {
		return localize('vibez.team.now', "just now");
	}
	if (minutes < 60) {
		return localize('vibez.team.minutes', "{0} min ago", minutes);
	}
	const hours = Math.round(minutes / 60);
	return hours < 24 ? localize('vibez.team.hours', "{0} h ago", hours) : localize('vibez.team.days', "{0} d ago", Math.round(hours / 24));
}

/**
 * The team, in the Vibez sidebar: who is working on what right now, the
 * files each person's agents hold, messages and handoffs, the team's notes,
 * and what just happened. It updates by itself; the main process asks the
 * team every few seconds and this redraws only when something changed.
 *
 * The composers are built once and never redrawn, so a half-typed message
 * survives every update.
 */
export class VibezTeamView extends ViewPane {

	static readonly ID = 'workbench.view.vibez.team';

	private root!: HTMLElement;
	private top!: HTMLElement;
	private setup!: HTMLElement;
	private sections!: HTMLElement;
	private messageBox!: HTMLElement;
	private noteBox!: HTMLElement;
	private recipient!: HTMLSelectElement;
	private state: IVibezTeamState | undefined;
	private setupFor = '';
	private readonly drawn = this._register(new DisposableStore());
	private readonly setupDrawn = this._register(new DisposableStore());

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
		@IVibezTeamService private readonly team: IVibezTeamService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
		@IClipboardService private readonly clipboard: IClipboardService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService,
			viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.root = dom.append(container, dom.$('.vibez-team'));
		dom.append(this.root, dom.$('style')).textContent = TEAM_CSS;
		this.top = dom.append(this.root, dom.$('.vt-header'));
		this.setup = dom.append(this.root, dom.$('.vt-setup'));
		this.sections = dom.append(this.root, dom.$('.vt-body'));
		this.messageBox = dom.append(this.root, dom.$('.vt-compose'));
		this.noteBox = dom.append(this.root, dom.$('.vt-compose'));
		this.buildMessageComposer();
		this.buildNoteComposer();

		this._register(this.team.onDidChange(state => this.show(state)));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.readMessages();
			}
		}));
		const folder = this.contextService.getWorkspace().folders[0];
		if (folder?.uri.scheme === 'file') {
			this.team.open(folder.uri.fsPath).then(state => this.show(state), error => this.fail(String(error)));
		} else {
			this.show({ status: 'closed', root: '', members: [], agents: [], claims: [], messages: [], notes: [], activity: [], unread: 0, updatedAt: Date.now() });
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.root.style.height = `${height}px`;
	}

	private fail(reason: string | undefined): void {
		if (reason) {
			this.notifications.notify({ severity: Severity.Warning, message: reason });
		}
	}

	private async run(action: Promise<IVibezTeamResult>): Promise<IVibezTeamResult> {
		const result = await action;
		if (!result.ok) {
			this.fail(result.reason);
		}
		return result;
	}

	private readMessages(): void {
		if (this.isBodyVisible() && this.state?.messages.some(m => m.unread && m.kind === 'message')) {
			void this.team.markRead();
		}
	}

	private open(path: string): void {
		const dir = this.state?.projectDir;
		if (dir) {
			void this.editorService.openEditor({ resource: URI.file(`${dir}/${path.split('#')[0]}`) });
		}
	}

	private show(state: IVibezTeamState): void {
		this.state = state;
		const ready = state.status === 'ready';
		this.messageBox.style.display = ready ? '' : 'none';
		this.noteBox.style.display = ready ? '' : 'none';
		// Listeners of the last drawing go first, the header's included.
		this.drawn.clear();
		this.drawHeader(state);
		this.renderSetup(state);
		dom.clearNode(this.sections);
		if (ready) {
			this.renderAgents(state);
			this.renderMessages(state);
			this.renderNotes(state);
			this.renderActivity(state);
			this.fillRecipients(state);
			this.readMessages();
		}
	}

	// ---- header and setup ----------------------------------------------------

	private drawHeader(state: IVibezTeamState): void {
		dom.clearNode(this.top);
		const title = dom.append(this.top, dom.$('.vt-title'));
		if (state.status === 'ready') {
			title.textContent = state.team ?? localize('vibez.team.team', "Team");
			const who = dom.append(this.top, dom.$('.vt-who'));
			who.textContent = state.members.length === 1
				? localize('vibez.team.asAlone', "you are {0} · just you so far", state.me ?? '')
				: localize('vibez.team.as', "you are {0} · {1} people", state.me ?? '', state.members.length);
			const code = dom.append(this.top, dom.$<HTMLButtonElement>('button.vt-link'));
			code.textContent = localize('vibez.team.code', "Copy join code");
			code.title = localize('vibez.team.codeTitle', "A teammate joins with this code. Share it only with people you want on the team.");
			this.drawn.add(dom.addDisposableListener(code, 'click', async () => {
				const result = await this.run(this.team.joinCode());
				if (result.ok && result.code) {
					await this.clipboard.writeText(result.code);
					this.notifications.info(localize('vibez.team.copied', "Join code copied. A teammate opens this project and joins with it in the Team view, or runs: npm run team -- join {0} --as <name>", result.code));
				}
			}));
		} else if (state.status === 'error') {
			title.textContent = state.team ?? localize('vibez.team.team', "Team");
			dom.append(this.top, dom.$('.vt-warn')).textContent = localize('vibez.team.unreachable', "Can't reach the team: {0}", state.reason ?? '');
		} else if (state.status === 'outside') {
			title.textContent = state.team ?? '';
		}
		// With no team yet the section header already says "Team".
		this.top.style.display = title.textContent ? '' : 'none';
	}

	/** The forms are drawn once per status, not on every update, so typing in them is never interrupted. */
	private renderSetup(state: IVibezTeamState): void {
		const key = `${state.status}:${state.projectDir ?? ''}`;
		if (key === this.setupFor) {
			return;
		}
		this.setupFor = key;
		this.setupDrawn.clear();
		dom.clearNode(this.setup);
		if (state.status === 'closed') {
			dom.append(this.setup, dom.$('.vt-hint')).textContent = localize('vibez.team.noFolder', "Open a folder to work on it with a team.");
			return;
		}
		if (state.status !== 'none' && state.status !== 'outside') {
			return;
		}
		if (state.status === 'none') {
			dom.append(this.setup, dom.$('.vt-hint')).textContent = localize('vibez.team.intro',
				"Work on this project with other people's agents: everyone sees who is working on what, and agents are warned before they touch someone else's files.");
		} else {
			dom.append(this.setup, dom.$('.vt-hint')).textContent = localize('vibez.team.outside', "This project has a team, \"{0}\". Join it with the code a teammate gives you.", state.team ?? '');
		}

		const join = this.form(localize('vibez.team.joinTitle', "Join a team"), [
			['code', localize('vibez.team.codeField', "Join code")],
			['as', localize('vibez.team.nameField', "Your name")],
			...(state.status === 'none' ? [
				['url', localize('vibez.team.urlField', "Supabase URL")] as [string, string],
				['key', localize('vibez.team.keyField', "Supabase anon key")] as [string, string],
			] : []),
		], localize('vibez.team.join', "Join"), async values => {
			const result = await this.run(this.team.join({ code: values.code, as: values.as, ...(values.url ? { url: values.url } : {}), ...(values.key ? { anonKey: values.key } : {}) }));
			return result.ok;
		});
		if (state.status === 'none') {
			const create = this.form(localize('vibez.team.createTitle', "Start a team"), [
				['team', localize('vibez.team.teamField', "Team name")],
				['as', localize('vibez.team.nameField', "Your name")],
				['url', localize('vibez.team.urlField', "Supabase URL")],
				['key', localize('vibez.team.keyField', "Supabase anon key")],
			], localize('vibez.team.create', "Create"), async values => {
				const result = await this.run(this.team.create({ team: values.team, as: values.as, url: values.url, anonKey: values.key }));
				if (result.ok && result.code) {
					await this.clipboard.writeText(result.code);
					this.notifications.info(localize('vibez.team.created', "Team created. vibez.team.json was written (commit it). The join code {0} is copied: give it to your teammates.", result.code));
				}
				return result.ok;
			});
			// Whoever starts the team comes first; everyone after them joins.
			this.setup.appendChild(create);
			this.setup.appendChild(join);
			dom.append(this.setup, dom.$('.vt-hint')).textContent = localize('vibez.team.supabase',
				"The Supabase project needs the migration in supabase/migrations and anonymous sign-ins on. For local work, run npx supabase start in the Vibez repository and use the URL and anon key it prints.");
		}
		if (state.status === 'outside') {
			this.setup.appendChild(join);
		}
	}

	private form(title: string, fields: [string, string][], action: string, submit: (values: Record<string, string>) => Promise<boolean>): HTMLElement {
		const form = dom.$('form.vt-form');
		dom.append(form, dom.$('.vt-form-title')).textContent = title;
		const inputs = new Map<string, HTMLInputElement>();
		for (const [name, label] of fields) {
			const input = dom.append(form, dom.$<HTMLInputElement>('input.vt-input'));
			input.placeholder = label;
			input.setAttribute('aria-label', label);
			input.spellcheck = false;
			inputs.set(name, input);
		}
		const button = dom.append(form, dom.$<HTMLButtonElement>('button.vt-primary'));
		button.type = 'submit';
		button.textContent = action;
		this.setupDrawn.add(dom.addDisposableListener(form, 'submit', async (e: Event) => {
			e.preventDefault();
			const values = Object.fromEntries([...inputs].map(([k, v]) => [k, v.value.trim()]));
			const missing = fields.find(([name]) => !values[name]);
			if (missing) {
				inputs.get(missing[0])!.focus();
				return;
			}
			button.disabled = true;
			try {
				await submit(values);
			} finally {
				button.disabled = false;
			}
		}));
		return form;
	}

	// ---- sections --------------------------------------------------------------

	private section(title: string, count?: number): HTMLElement {
		const section = dom.append(this.sections, dom.$('.vt-section'));
		const head = dom.append(section, dom.$('.vt-section-title'));
		head.textContent = title;
		if (count) {
			dom.append(head, dom.$('span.vt-badge')).textContent = String(count);
		}
		return section;
	}

	private chip(parent: HTMLElement, path: string): void {
		const chip = dom.append(parent, dom.$<HTMLButtonElement>('button.vt-file'));
		chip.textContent = path;
		chip.title = localize('vibez.team.openFile', "Open {0}", path.split('#')[0]);
		this.drawn.add(dom.addDisposableListener(chip, 'click', () => this.open(path)));
	}

	private renderAgents(state: IVibezTeamState): void {
		const section = this.section(localize('vibez.team.working', "Working now"));
		if (!state.agents.length) {
			dom.append(section, dom.$('.vt-hint')).textContent = localize('vibez.team.nobody', "Nobody's agent is working right now. An agent shows up here once it calls team_start or edits through the Vibez tools.");
			return;
		}
		// Other people first: they are the ones to stay out of the way of.
		const agents = [...state.agents].sort((a, b) => Number(a.you) - Number(b.you) || Number(b.online) - Number(a.online));
		for (const agent of agents) {
			const row = dom.append(section, dom.$('.vt-agent'));
			row.classList.toggle('quiet', !agent.online);
			const top = dom.append(row, dom.$('.vt-agent-top'));
			dom.append(top, dom.$('span.vt-dot')).title = agent.online ? localize('vibez.team.active', "active") : localize('vibez.team.quiet', "quiet since {0}", ago(agent.lastSeen));
			dom.append(top, dom.$('span.vt-person')).textContent = agent.you ? localize('vibez.team.you', "{0} (you)", agent.person) : agent.person;
			dom.append(top, dom.$('span.vt-kind')).textContent = agent.kind === 'vibez' ? localize('vibez.team.ide', "in the IDE") : agent.kind;
			if (!agent.online) {
				dom.append(top, dom.$('span.vt-kind')).textContent = localize('vibez.team.quietFor', "quiet {0}", ago(agent.lastSeen));
			}
			dom.append(row, dom.$('.vt-task')).textContent = agent.task || localize('vibez.team.noTask', "no task given");
			if (agent.claims.length) {
				const files = dom.append(row, dom.$('.vt-files'));
				agent.claims.forEach(path => this.chip(files, path));
			}
			if (agent.you && agent.kind === 'vibez' && agent.claims.length) {
				const release = dom.append(row, dom.$<HTMLButtonElement>('button.vt-link'));
				release.textContent = localize('vibez.team.release', "Let go of these files");
				this.drawn.add(dom.addDisposableListener(release, 'click', () => void this.run(this.team.release())));
			}
		}
	}

	private renderMessages(state: IVibezTeamState): void {
		const section = this.section(localize('vibez.team.messages', "Messages"), state.unread);
		if (!state.messages.length) {
			dom.append(section, dom.$('.vt-hint')).textContent = localize('vibez.team.noMessages', "No messages yet. Agents message people with team_message and pass work on with team_handoff.");
			return;
		}
		for (const m of state.messages.slice(-25)) {
			const row = dom.append(section, dom.$('.vt-message'));
			row.classList.toggle('unread', m.unread);
			row.classList.toggle('mine', m.fromYou);
			const meta = dom.append(row, dom.$('.vt-meta'));
			const route = m.kind === 'handoff'
				? localize('vibez.team.handoffRoute', "{0} handed work to {1}", m.fromYou ? localize('vibez.team.youWord', "you") : m.from, m.to)
				: localize('vibez.team.route', "{0} → {1}", m.fromYou ? localize('vibez.team.youWord', "you") : m.from, m.to);
			dom.append(meta, dom.$('span')).textContent = route;
			dom.append(meta, dom.$('span.vt-when')).textContent = ago(m.at);
			dom.append(row, dom.$('.vt-text')).textContent = m.body;
			if (m.kind === 'handoff') {
				row.classList.add('handoff');
				if (m.task) {
					dom.append(row, dom.$('.vt-detail')).textContent = localize('vibez.team.handoffTask', "Task: {0}", m.task);
				}
				if (m.next?.length) {
					const list = dom.append(row, dom.$('ol.vt-next'));
					m.next.forEach(step => { dom.append(list, dom.$('li')).textContent = step; });
				}
				if (m.paths?.length) {
					const files = dom.append(row, dom.$('.vt-files'));
					m.paths.forEach(path => this.chip(files, path));
				}
				if (m.takenBy) {
					dom.append(row, dom.$('.vt-detail')).textContent = localize('vibez.team.taken', "Taken over by {0}", m.takenBy);
				} else if (!m.fromYou) {
					const take = dom.append(row, dom.$<HTMLButtonElement>('button.vt-primary'));
					take.textContent = localize('vibez.team.take', "Take over");
					take.title = localize('vibez.team.takeTitle', "Its files are claimed for you, here in the IDE. To have your agent take it instead, ask it to accept the handoff with team_accept.");
					this.drawn.add(dom.addDisposableListener(take, 'click', () => void this.run(this.team.accept(m.id))));
				}
			}
		}
		section.scrollTop = section.scrollHeight;
	}

	private renderNotes(state: IVibezTeamState): void {
		const section = this.section(localize('vibez.team.notes', "Team notes"));
		if (!state.notes.length) {
			dom.append(section, dom.$('.vt-hint')).textContent = localize('vibez.team.noNotes', "Decisions, gotchas and conventions the team wants every agent to know. Agents see a file's notes when they start work on it.");
			return;
		}
		for (const note of state.notes.slice(0, 30)) {
			const row = dom.append(section, dom.$('.vt-note'));
			const meta = dom.append(row, dom.$('.vt-meta'));
			dom.append(meta, dom.$(`span.vt-tag.${note.kind}`)).textContent = note.kind;
			if (note.path) {
				this.chip(meta, note.path);
			}
			dom.append(meta, dom.$('span.vt-when')).textContent = `${note.person} · ${ago(note.at)}`;
			const forget = dom.append(meta, dom.$<HTMLButtonElement>('button.vt-x.codicon.codicon-close'));
			forget.title = localize('vibez.team.forget', "Take this note down for everyone");
			this.drawn.add(dom.addDisposableListener(forget, 'click', () => void this.run(this.team.forget(note.id))));
			dom.append(row, dom.$('.vt-text')).textContent = note.body;
		}
	}

	private renderActivity(state: IVibezTeamState): void {
		const section = this.section(localize('vibez.team.recent', "Recently"));
		for (const a of state.activity.slice(0, 15)) {
			const row = dom.append(section, dom.$('.vt-activity'));
			dom.append(row, dom.$('span.vt-when')).textContent = ago(a.at);
			const text = dom.append(row, dom.$('span'));
			text.textContent = `${a.person} ${a.verb}${a.target ? ` ${a.target}` : ''}`;
			if (a.detail) {
				text.title = a.detail;
			}
		}
	}

	// ---- composers -------------------------------------------------------------

	private buildMessageComposer(): void {
		const line = dom.append(this.messageBox, dom.$('.vt-line'));
		this.recipient = dom.append(line, dom.$<HTMLSelectElement>('select.vt-select'));
		this.recipient.setAttribute('aria-label', localize('vibez.team.to', "To"));
		const input = dom.append(this.messageBox, dom.$<HTMLTextAreaElement>('textarea.vt-input'));
		input.rows = 2;
		input.placeholder = localize('vibez.team.messagePlaceholder', "Message the team… (Enter sends)");
		const send = async () => {
			const text = input.value.trim();
			if (!text) {
				return;
			}
			input.disabled = true;
			const result = await this.run(this.team.message(this.recipient.value || 'everyone', text));
			input.disabled = false;
			if (result.ok) {
				input.value = '';
			}
			input.focus();
		};
		this._register(dom.addDisposableListener(input, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void send();
			}
		}));
		const button = dom.append(line, dom.$<HTMLButtonElement>('button.vt-primary'));
		button.textContent = localize('vibez.team.send', "Send");
		this._register(dom.addDisposableListener(button, 'click', () => void send()));
	}

	private fillRecipients(state: IVibezTeamState): void {
		const chosen = this.recipient.value;
		const names = ['everyone', ...state.members.filter(m => !m.you).map(m => m.name)];
		if ([...this.recipient.options].map(o => o.value).join('|') === names.join('|')) {
			return;
		}
		dom.clearNode(this.recipient);
		for (const name of names) {
			const option = dom.append(this.recipient, dom.$<HTMLOptionElement>('option'));
			option.value = name;
			option.textContent = name === 'everyone' ? localize('vibez.team.everyone', "To everyone") : localize('vibez.team.toPerson', "To {0}", name);
		}
		this.recipient.value = names.includes(chosen) ? chosen : 'everyone';
	}

	private buildNoteComposer(): void {
		const line = dom.append(this.noteBox, dom.$('.vt-line'));
		const kind = dom.append(line, dom.$<HTMLSelectElement>('select.vt-select'));
		for (const k of NOTE_KINDS) {
			const option = dom.append(kind, dom.$<HTMLOptionElement>('option'));
			option.value = k;
			option.textContent = k;
		}
		const onFile = dom.append(line, dom.$('label.vt-check'));
		const check = dom.append(onFile, dom.$<HTMLInputElement>('input'));
		check.type = 'checkbox';
		check.checked = true;
		dom.append(onFile, dom.$('span')).textContent = localize('vibez.team.onFile', "on the open file");
		const input = dom.append(this.noteBox, dom.$<HTMLInputElement>('input.vt-input'));
		input.placeholder = localize('vibez.team.notePlaceholder', "Leave a note for every agent… (Enter saves)");
		this._register(dom.addDisposableListener(input, 'keydown', async (e: KeyboardEvent) => {
			if (e.key !== 'Enter' || e.isComposing || !input.value.trim()) {
				return;
			}
			e.preventDefault();
			const resource = this.editorService.activeEditor?.resource;
			const path = check.checked && resource?.scheme === 'file' ? teamPath(this.state, resource.fsPath) : undefined;
			const result = await this.run(this.team.remember(input.value.trim(), kind.value, path));
			if (result.ok) {
				input.value = '';
			}
		}));
	}
}

const TEAM_CSS = `
.vibez-team{display:flex;flex-direction:column;gap:8px;padding:6px 12px 10px;box-sizing:border-box;overflow:auto;font-size:12px}
.vibez-team button{font:inherit;border-radius:4px;padding:3px 10px;cursor:pointer;border:1px solid transparent;white-space:nowrap}
.vibez-team button:disabled{opacity:.5;cursor:default}
.vibez-team .vt-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);align-self:flex-start}
.vibez-team .vt-primary:hover{background:var(--vscode-button-hoverBackground)}
.vibez-team .vt-link{background:none;color:var(--vscode-textLink-foreground);padding:0;align-self:flex-start}
.vibez-team .vt-link:hover{text-decoration:underline}
.vibez-team .vt-header{display:flex;flex-direction:column;gap:2px}
.vibez-team .vt-title{font-weight:600;font-size:13px}
.vibez-team .vt-who,.vibez-team .vt-hint,.vibez-team .vt-when,.vibez-team .vt-kind,.vibez-team .vt-detail{color:var(--vscode-descriptionForeground)}
.vibez-team .vt-hint{line-height:1.45}
.vibez-team .vt-warn{color:var(--vscode-editorWarning-foreground)}
.vibez-team .vt-setup{display:flex;flex-direction:column;gap:10px}
.vibez-team .vt-setup:empty{display:none}
.vibez-team .vt-form{display:flex;flex-direction:column;gap:5px;padding:8px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));border-radius:6px}
.vibez-team .vt-form-title,.vibez-team .vt-section-title{font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.04em;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:6px}
.vibez-team .vt-input,.vibez-team .vt-select{padding:4px 7px;border-radius:4px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit;min-width:0;box-sizing:border-box}
.vibez-team textarea.vt-input{resize:vertical;width:100%}
.vibez-team input.vt-input{width:100%}
.vibez-team .vt-input:focus,.vibez-team .vt-select:focus{outline:1px solid var(--vscode-focusBorder)}
.vibez-team .vt-body{display:flex;flex-direction:column;gap:12px}
.vibez-team .vt-section{display:flex;flex-direction:column;gap:6px}
.vibez-team .vt-badge{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:8px;padding:0 6px;font-size:10px;letter-spacing:0}
.vibez-team .vt-agent,.vibez-team .vt-message,.vibez-team .vt-note{display:flex;flex-direction:column;gap:3px;padding:6px 8px;border-radius:6px;background:var(--vscode-sideBarSectionHeader-background,rgba(128,128,128,.08))}
.vibez-team .vt-agent-top,.vibez-team .vt-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.vibez-team .vt-dot{width:7px;height:7px;border-radius:50%;background:var(--vscode-testing-iconPassed,#3fb950);flex:none}
.vibez-team .vt-agent.quiet{opacity:.7}
.vibez-team .vt-agent.quiet .vt-dot{background:var(--vscode-descriptionForeground)}
.vibez-team .vt-person{font-weight:600}
.vibez-team .vt-files{display:flex;flex-wrap:wrap;gap:4px}
.vibez-team .vt-file{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:0 6px;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:11px;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.vibez-team .vt-message.unread{box-shadow:inset 2px 0 0 var(--vscode-focusBorder)}
.vibez-team .vt-message.handoff{border:1px solid var(--vscode-focusBorder)}
.vibez-team .vt-message .vt-when,.vibez-team .vt-note .vt-when{margin-left:auto}
.vibez-team .vt-text{white-space:pre-wrap;word-break:break-word;line-height:1.4}
.vibez-team .vt-next{margin:0;padding-left:18px}
.vibez-team .vt-tag{font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:0 5px;border-radius:3px;border:1px solid currentColor;color:var(--vscode-descriptionForeground)}
.vibez-team .vt-tag.gotcha{color:var(--vscode-editorWarning-foreground)}
.vibez-team .vt-tag.decision{color:var(--vscode-textLink-foreground)}
.vibez-team .vt-x{background:none;padding:0 2px;color:var(--vscode-descriptionForeground)}
.vibez-team .vt-activity{display:flex;gap:8px;line-height:1.5}
.vibez-team .vt-activity .vt-when{flex:none;width:64px}
.vibez-team .vt-compose{display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));padding-top:8px}
.vibez-team .vt-line{display:flex;gap:6px;align-items:center}
.vibez-team .vt-line .vt-select{flex:1}
.vibez-team .vt-check{display:flex;gap:4px;align-items:center;color:var(--vscode-descriptionForeground);white-space:nowrap}
`;
