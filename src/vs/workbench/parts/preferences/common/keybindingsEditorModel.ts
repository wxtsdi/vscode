/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { TPromise } from 'vs/base/common/winjs.base';
import { distinct } from 'vs/base/common/arrays';
import * as strings from 'vs/base/common/strings';
import { OperatingSystem, language, LANGUAGE_DEFAULT } from 'vs/base/common/platform';
import { IMatch, IFilter, or, matchesContiguousSubString, matchesPrefix, matchesCamelCase, matchesWords } from 'vs/base/common/filters';
import { Registry } from 'vs/platform/platform';
import { ResolvedKeybinding } from 'vs/base/common/keyCodes';
import { AriaLabelProvider, UserSettingsLabelProvider, UILabelProvider, ModifierLabels as ModLabels } from 'vs/platform/keybinding/common/keybindingLabels';
import { CommonEditorRegistry, EditorAction } from 'vs/editor/common/editorCommonExtensions';
import { MenuRegistry, ILocalizedString, SyncActionDescriptor, ICommandAction } from 'vs/platform/actions/common/actions';
import { IWorkbenchActionRegistry, Extensions as ActionExtensions } from 'vs/workbench/common/actionRegistry';
import { EditorModel } from 'vs/workbench/common/editor';
import { IExtensionService } from 'vs/platform/extensions/common/extensions';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ResolvedKeybindingItem } from 'vs/platform/keybinding/common/resolvedKeybindingItem';
import { KeybindingResolver } from 'vs/platform/keybinding/common/keybindingResolver';

export const KEYBINDING_ENTRY_TEMPLATE_ID = 'keybinding.entry.template';
export const KEYBINDING_HEADER_TEMPLATE_ID = 'keybinding.header.template';

export interface KeybindingMatch {
	ctrlKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	keyCode?: boolean;
}

export interface KeybindingMatches {
	firstPart: KeybindingMatch;
	chordPart: KeybindingMatch;
}

export interface IListEntry {
	id: string;
	templateId: string;
}

export interface IKeybindingItemEntry extends IListEntry {
	keybindingItem: IKeybindingItem;
	commandIdMatches?: IMatch[];
	commandLabelMatches?: IMatch[];
	commandDefaultLabelMatches?: IMatch[];
	sourceMatches?: IMatch[];
	whenMatches?: IMatch[];
	keybindingMatches?: KeybindingMatches;
}

export interface IKeybindingItem {
	keybinding: ResolvedKeybinding;
	keybindingItem: ResolvedKeybindingItem;
	commandLabel: string;
	commandDefaultLabel: string;
	command: string;
	source: string;
	when: string;
}

interface ModifierLabels {
	ui: ModLabels;
	aria: ModLabels;
	user: ModLabels;
}

const wordFilter = or(matchesPrefix, matchesWords, matchesContiguousSubString);

export class KeybindingsEditorModel extends EditorModel {

	private _keybindingItems: IKeybindingItem[];
	private modifierLabels: ModifierLabels;

	constructor(
		private os: OperatingSystem,
		@IKeybindingService private keybindingsService: IKeybindingService,
		@IExtensionService private extensionService: IExtensionService
	) {
		super();
		this.modifierLabels = {
			ui: UILabelProvider.modifierLabels[os],
			aria: AriaLabelProvider.modifierLabels[os],
			user: UserSettingsLabelProvider.modifierLabels[os]
		};
	}

	public fetch(searchValue: string): IKeybindingItemEntry[] {
		searchValue = searchValue.trim();
		return searchValue ? this.fetchKeybindingItems(searchValue) :
			this._keybindingItems.map(keybindingItem => ({ id: KeybindingsEditorModel.getId(keybindingItem), keybindingItem, templateId: KEYBINDING_ENTRY_TEMPLATE_ID }));
	}

	private fetchKeybindingItems(searchValue: string): IKeybindingItemEntry[] {
		const result: IKeybindingItemEntry[] = [];
		const words = searchValue.split(' ');
		const keybindingWords = searchValue.indexOf('+') !== -1 ? searchValue.split('+') : words;
		for (const keybindingItem of this._keybindingItems) {
			let keybindingMatches = new KeybindingItemMatches(this.modifierLabels, keybindingItem, searchValue, words, keybindingWords);
			if (keybindingMatches.commandIdMatches
				|| keybindingMatches.commandLabelMatches
				|| keybindingMatches.commandDefaultLabelMatches
				|| keybindingMatches.sourceMatches
				|| keybindingMatches.whenMatches
				|| keybindingMatches.keybindingMatches) {
				result.push({
					id: KeybindingsEditorModel.getId(keybindingItem),
					templateId: KEYBINDING_ENTRY_TEMPLATE_ID,
					commandLabelMatches: keybindingMatches.commandLabelMatches,
					commandDefaultLabelMatches: keybindingMatches.commandDefaultLabelMatches,
					keybindingItem,
					keybindingMatches: keybindingMatches.keybindingMatches,
					commandIdMatches: keybindingMatches.commandIdMatches,
					sourceMatches: keybindingMatches.sourceMatches,
					whenMatches: keybindingMatches.whenMatches
				});
			}
		}
		return result;
	}

	public resolve(): TPromise<EditorModel> {
		return this.extensionService.onReady()
			.then(() => {
				const workbenchActionsRegistry = Registry.as<IWorkbenchActionRegistry>(ActionExtensions.WorkbenchActions);
				const editorActions = CommonEditorRegistry.getEditorActions().reduce((editorActions, editorAction) => {
					editorActions[editorAction.id] = editorAction;
					return editorActions;
				}, {});

				this._keybindingItems = [];
				const boundCommands: Map<string, boolean> = new Map<string, boolean>();
				for (const keybinding of this.keybindingsService.getKeybindings()) {
					if (keybinding.command) { // Skip keybindings without commands
						this._keybindingItems.push(KeybindingsEditorModel.toKeybindingEntry(keybinding.command, keybinding, workbenchActionsRegistry, editorActions));
						boundCommands.set(keybinding.command, true);
					}
				}

				const commandsWithDefaultKeybindings = this.keybindingsService.getDefaultKeybindings().map(keybinding => keybinding.command);
				for (const command of KeybindingResolver.getAllUnboundCommands(boundCommands)) {
					const keybindingItem = new ResolvedKeybindingItem(null, command, null, null, commandsWithDefaultKeybindings.indexOf(command) === -1);
					this._keybindingItems.push(KeybindingsEditorModel.toKeybindingEntry(command, keybindingItem, workbenchActionsRegistry, editorActions));
				}
				this._keybindingItems = this._keybindingItems.sort((a, b) => KeybindingsEditorModel.compareKeybindingData(a, b));
				return this;
			});
	}

	private static getId(keybindingItem: IKeybindingItem): string {
		return keybindingItem.command + (keybindingItem.keybinding ? keybindingItem.keybinding.getAriaLabel() : '') + keybindingItem.source + keybindingItem.when;
	}

	private static compareKeybindingData(a: IKeybindingItem, b: IKeybindingItem): number {
		if (a.keybinding && !b.keybinding) {
			return -1;
		}
		if (b.keybinding && !a.keybinding) {
			return 1;
		}
		if (a.commandLabel && !b.commandLabel) {
			return -1;
		}
		if (b.commandLabel && !a.commandLabel) {
			return 1;
		}
		if (a.commandLabel && b.commandLabel) {
			if (a.commandLabel !== b.commandLabel) {
				return a.commandLabel.localeCompare(b.commandLabel);
			}
		}
		if (a.command === b.command) {
			return a.keybindingItem.isDefault ? 1 : -1;
		}
		return a.command.localeCompare(b.command);
	}

	private static toKeybindingEntry(command: string, keybindingItem: ResolvedKeybindingItem, workbenchActionsRegistry: IWorkbenchActionRegistry, editorActions: {}): IKeybindingItem {
		const workbenchAction = workbenchActionsRegistry.getWorkbenchAction(command);
		const menuCommand = MenuRegistry.getCommand(command);
		const editorAction: EditorAction = editorActions[command];
		return <IKeybindingItem>{
			keybinding: keybindingItem.resolvedKeybinding,
			keybindingItem,
			command,
			commandLabel: KeybindingsEditorModel.getCommandLabel(workbenchAction, menuCommand, editorAction),
			commandDefaultLabel: KeybindingsEditorModel.getCommandDefaultLabel(workbenchAction, menuCommand, workbenchActionsRegistry),
			when: keybindingItem.when ? keybindingItem.when.serialize() : '',
			source: keybindingItem.isDefault ? localize('default', "Default") : localize('user', "User")
		};
	}

	private static getCommandDefaultLabel(workbenchAction: SyncActionDescriptor, menuCommand: ICommandAction, workbenchActionsRegistry: IWorkbenchActionRegistry): string {
		if (language !== LANGUAGE_DEFAULT) {
			if (workbenchAction) {
				return workbenchActionsRegistry.getAlias(workbenchAction.id);
			}

			if (menuCommand && menuCommand.title && (<ILocalizedString>menuCommand.title).original) {
				return (<ILocalizedString>menuCommand.title).original;
			}
		}
		return null;
	}

	private static getCommandLabel(workbenchAction: SyncActionDescriptor, menuCommand: ICommandAction, editorAction: EditorAction): string {
		if (workbenchAction) {
			return workbenchAction.label;
		}

		if (menuCommand) {
			return typeof menuCommand.title === 'string' ? menuCommand.title : menuCommand.title.value;
		}

		if (editorAction) {
			return editorAction.label;
		}

		return '';
	}
}

class KeybindingItemMatches {

	public readonly commandIdMatches: IMatch[] = null;
	public readonly commandLabelMatches: IMatch[] = null;
	public readonly commandDefaultLabelMatches: IMatch[] = null;
	public readonly sourceMatches: IMatch[] = null;
	public readonly whenMatches: IMatch[] = null;
	public readonly keybindingMatches: KeybindingMatches = null;

	constructor(private modifierLabels: ModifierLabels, keybindingItem: IKeybindingItem, private searchValue: string, private words: string[], private keybindingWords: string[]) {
		this.commandIdMatches = this.matches(searchValue, keybindingItem.command, or(matchesWords, matchesCamelCase), words);
		this.commandLabelMatches = keybindingItem.commandLabel ? this.matches(searchValue, keybindingItem.commandLabel, (word, wordToMatchAgainst) => matchesWords(word, keybindingItem.commandLabel, true), words) : null;
		this.commandDefaultLabelMatches = keybindingItem.commandDefaultLabel ? this.matches(searchValue, keybindingItem.commandDefaultLabel, (word, wordToMatchAgainst) => matchesWords(word, keybindingItem.commandDefaultLabel, true), words) : null;
		this.sourceMatches = this.matches(searchValue, keybindingItem.source, (word, wordToMatchAgainst) => matchesWords(word, keybindingItem.source, true), words);
		this.whenMatches = keybindingItem.when ? this.matches(searchValue, keybindingItem.when, or(matchesWords, matchesCamelCase), words) : null;
		this.keybindingMatches = keybindingItem.keybinding ? this.matchesKeybinding(keybindingItem.keybinding, searchValue, keybindingWords) : null;
	}

	private matches(searchValue: string, wordToMatchAgainst: string, wordMatchesFilter: IFilter, words: string[]): IMatch[] {
		let matches = wordFilter(searchValue, wordToMatchAgainst);
		if (!matches) {
			matches = this.matchesWords(words, wordToMatchAgainst, wordMatchesFilter);
		}
		if (matches) {
			matches = this.filterAndSort(matches);
		}
		return matches;
	}

	private matchesWords(words: string[], wordToMatchAgainst: string, wordMatchesFilter: IFilter): IMatch[] {
		let matches = [];
		for (const word of words) {
			const wordMatches = wordMatchesFilter(word, wordToMatchAgainst);
			if (wordMatches) {
				matches = [...(matches || []), ...wordMatches];
			} else {
				matches = null;
				break;
			}
		}
		return matches;
	}

	private filterAndSort(matches: IMatch[]): IMatch[] {
		return distinct(matches, (a => a.start + '.' + a.end)).filter(match => !matches.some(m => !(m.start === match.start && m.end === match.end) && (m.start <= match.start && m.end >= match.end))).sort((a, b) => a.start - b.start);;
	}

	private matchesKeybinding(keybinding: ResolvedKeybinding, searchValue: string, words: string[]): KeybindingMatches {
		if (strings.compareIgnoreCase(searchValue, keybinding.getAriaLabel()) === 0 || strings.compareIgnoreCase(searchValue, keybinding.getLabel()) === 0) {
			return {
				firstPart: { metaKey: true, altKey: true, shiftKey: true, ctrlKey: true, keyCode: true },
				chordPart: { metaKey: true, altKey: true, shiftKey: true, ctrlKey: true, keyCode: true }
			};
		}
		const [firstPart, chordPart] = keybinding.getParts();
		const matchedWords = [];
		const firstPartMatch: KeybindingMatch = {};
		const chordPartMatch: KeybindingMatch = {};
		for (const word of words) {
			let firstPartMatched = this.matchPart(firstPart, firstPartMatch, word);
			let chordPartMatched = this.matchPart(chordPart, chordPartMatch, word);
			if (firstPartMatched || chordPartMatched) {
				matchedWords.push(word);
			}
		}
		if (matchedWords.length !== words.length) {
			return null;
		}
		return this.hasAnyMatch(firstPartMatch) || this.hasAnyMatch(chordPartMatch) ? { firstPart: firstPartMatch, chordPart: chordPartMatch } : null;
	}

	private matchPart(part: ResolvedKeybinding, match: KeybindingMatch, word: string): boolean {
		let matched = false;
		if (this.matchesMetaModifier(part, word)) {
			matched = true;
			match.metaKey = true;
		}
		if (this.matchesCtrlModifier(part, word)) {
			matched = true;
			match.ctrlKey = true;
		}
		if (this.matchesShiftModifier(part, word)) {
			matched = true;
			match.shiftKey = true;
		}
		if (this.matchesAltModifier(part, word)) {
			matched = true;
			match.altKey = true;
		}
		if (this.matchesKeyCode(part, word)) {
			match.keyCode = true;
			matched = true;
		}
		return matched;
	}

	private matchesKeyCode(keybinding: ResolvedKeybinding, word: string): boolean {
		if (!keybinding) {
			return false;
		}
		const ariaLabel = keybinding.getAriaLabelWithoutModifiers();
		if (ariaLabel.length === 1 || word.length === 1) {
			if (strings.compareIgnoreCase(ariaLabel, word) === 0) {
				return true;
			}
		} else {
			if (matchesContiguousSubString(word, ariaLabel)) {
				return true;
			}
		}
		return false;
	}

	private matchesMetaModifier(keybinding: ResolvedKeybinding, word: string): boolean {
		if (!keybinding) {
			return false;
		}
		if (!keybinding.hasMetaModifier()) {
			return false;
		}
		if (matchesPrefix(this.modifierLabels.ui.metaKey, word)) {
			return true;
		}
		if (matchesPrefix(this.modifierLabels.aria.metaKey, word)) {
			return true;
		}
		if (matchesPrefix(this.modifierLabels.user.metaKey, word)) {
			return true;
		}
		return false;
	}

	private matchesCtrlModifier(keybinding: ResolvedKeybinding, word: string): boolean {
		if (!keybinding) {
			return false;
		}
		if (!keybinding.hasCtrlModifier()) {
			return false;
		}
		if (matchesPrefix(this.modifierLabels.ui.ctrlKey, word)) {
			return true;
		}
		if (matchesPrefix(this.modifierLabels.aria.ctrlKey, word)) {
			return true;
		}
		if (matchesPrefix(this.modifierLabels.user.ctrlKey, word)) {
			return true;
		}
		return false;
	}

	private matchesShiftModifier(keybinding: ResolvedKeybinding, word: string): boolean {
		if (!keybinding) {
			return false;
		}
		if (!keybinding.hasShiftModifier()) {
			return false;
		}
		if (matchesPrefix(this.modifierLabels.ui.shiftKey, word)) {
			return true;
		}
		if (matchesPrefix(this.modifierLabels.aria.shiftKey, word)) {
			return true;
		}
		if (matchesPrefix(this.modifierLabels.user.shiftKey, word)) {
			return true;
		}
		return false;
	}

	private matchesAltModifier(keybinding: ResolvedKeybinding, word: string): boolean {
		if (!keybinding) {
			return false;
		}
		if (!keybinding.hasAltModifier()) {
			return false;
		}
		if (matchesPrefix(this.modifierLabels.ui.altKey, word)) {
			return true;
		}
		if (matchesPrefix(this.modifierLabels.aria.altKey, word)) {
			return true;
		}
		if (matchesPrefix(this.modifierLabels.user.altKey, word)) {
			return true;
		}
		return false;
	}

	private hasAnyMatch(keybindingMatch: KeybindingMatch): boolean {
		return keybindingMatch.altKey ||
			keybindingMatch.ctrlKey ||
			keybindingMatch.metaKey ||
			keybindingMatch.shiftKey ||
			keybindingMatch.keyCode;
	}
}