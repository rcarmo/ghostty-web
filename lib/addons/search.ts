import { buildTextIndex, matchText, type SearchOptions, type TextIndex } from './text-search';
import { EventEmitter } from '../event-emitter';
import type { GhosttyTerminal } from '../ghostty';
import type { ITerminalAddon, ITerminalCore, IDisposable } from '../interfaces';
import type { TerminalSearch } from '../search';
import type { Terminal } from '../terminal';

export interface SearchResults {
  resultIndex: number;
  resultCount: number;
  pending?: boolean;
  truncated?: boolean;
  error?: string;
}
/** Focused-terminal literal search. findNext moves towards older output. */
export class SearchAddon implements ITerminalAddon {
  private terminal?: Terminal;
  private wasm?: GhosttyTerminal;
  private search?: TerminalSearch;
  private subscription?: IDisposable;
  private cancelTimer?: () => void;
  private text = '';
  private options: SearchOptions = {};
  private generation = 0;
  private textIndex?: TextIndex;
  private advancedKey = '';
  private advancedMatches: import('../search').SearchMatch[] = [];
  private advancedIndex = -1;
  private advancedTruncated = false;
  private running = false;
  private runningKey = '';
  private disposed = false;
  private results = new EventEmitter<SearchResults>();
  readonly onDidChangeResults = this.results.event;
  activate(terminal: ITerminalCore): void {
    this.terminal = terminal as Terminal;
    this.subscription = this.terminal.onWriteParsed(() => {
      this.generation++;
      this.textIndex = undefined;
      this.advancedKey = '';
      this.running = false;
      if (!this.text || this.cancelTimer) return;
      const update = () => {
        this.cancelTimer = undefined;
        if (!this.disposed) this.find(this.text, undefined, this.options);
      };
      const view = this.terminal?.element?.ownerDocument.defaultView;
      if (view) {
        const id = view.setTimeout(update, 100);
        this.cancelTimer = () => view.clearTimeout(id);
      } else {
        const id = setTimeout(update, 100);
        this.cancelTimer = () => clearTimeout(id);
      }
    });
  }
  refresh(text: string, options: SearchOptions = {}): boolean {
    return this.find(text, undefined, options);
  }
  findNext(text: string, options: SearchOptions = {}): boolean {
    return this.find(text, true, options);
  }
  findPrevious(text: string, options: SearchOptions = {}): boolean {
    return this.find(text, false, options);
  }
  private find(text: string, older: boolean | undefined, options: SearchOptions = {}): boolean {
    const terminal = this.terminal;
    if (this.disposed || !terminal?.wasmTerm) return false;
    if (text.length > 1024) throw new RangeError('Search is limited to 1024 characters');
    if (this.wasm !== terminal.wasmTerm || this.search?.disposed) {
      this.search?.dispose();
      this.wasm = terminal.wasmTerm;
      this.search = this.wasm.createSearch();
    }
    const search = this.search!;
    this.text = text;
    this.options = { ...options };
    if (text && (options.regex || options.wholeWord || options.caseSensitive)) {
      search.setNeedle('');
      return this.findAdvanced(text, older);
    }
    this.generation++;
    this.running = false;
    this.advancedKey = '';
    search.setNeedle(text);
    search.run();
    let found = false;
    if (text && search.count > 0) {
      found = older === undefined && search.index >= 0 ? true : search.select(older ?? true);
      // Wrap by resetting the query, not by walking every match in JS.
      if (!found) {
        search.setNeedle('');
        search.setNeedle(text);
        search.run();
        found = search.select(older ?? true);
      }
    }
    const match = found ? search.selectedMatch() : null;
    if (match) {
      if (older !== undefined)
        terminal.scrollToLine(Math.max(0, terminal.getScrollbackLength() - match.startRow));
      const decorations = [];
      for (let row = match.startRow; row <= match.endRow; row++) {
        const column = row === match.startRow ? match.startCol : 0;
        const end = row === match.endRow ? match.endCol : terminal.cols - 1;
        decorations.push({
          line: row,
          column,
          length: end - column + 1,
          background: 'rgba(218,161,0,0.5)',
        });
      }
      terminal.setSearchDecorations(decorations);
    } else terminal.setSearchDecorations([]);
    this.results.fire({
      resultIndex: match ? search.count - 1 - search.index : -1,
      resultCount: search.count,
    });
    return !!match;
  }
  private findAdvanced(text: string, older: boolean | undefined): boolean {
    const key = JSON.stringify([text, this.options]);
    if (this.textIndex && key === this.advancedKey) {
      if (older !== undefined && this.advancedMatches.length)
        this.advancedIndex =
          (this.advancedIndex + (older ? -1 : 1) + this.advancedMatches.length) %
          this.advancedMatches.length;
      return this.presentAdvanced(older !== undefined);
    }
    if (this.running && this.runningKey === key) return false;
    this.running = true;
    this.runningKey = key;
    const options = { ...this.options };
    const generation = ++this.generation;
    this.results.fire({ resultIndex: -1, resultCount: 0, pending: true });
    void (async () => {
      const index =
        this.textIndex ??
        (await buildTextIndex(
          this.terminal!,
          () => this.disposed || generation !== this.generation
        ));
      if (this.disposed || generation !== this.generation) return;
      const result = matchText(index, text, options);
      this.textIndex = index;
      this.advancedKey = key;
      this.advancedMatches = result.matches;
      this.advancedIndex = older === false ? 0 : result.matches.length - 1;
      this.advancedTruncated = result.truncated;
      this.running = false;
      this.presentAdvanced(older !== undefined);
    })().catch((error) => {
      if (this.disposed || generation !== this.generation) return;
      this.running = false;
      this.terminal?.setSearchDecorations([]);
      this.results.fire({ resultIndex: -1, resultCount: 0, error: String(error) });
    });
    return false;
  }
  private presentAdvanced(navigate: boolean): boolean {
    const terminal = this.terminal!;
    const match = this.advancedMatches[this.advancedIndex];
    const decorations = [];
    if (match) {
      if (navigate)
        terminal.scrollToLine(Math.max(0, terminal.getScrollbackLength() - match.startRow));
      for (let row = match.startRow; row <= match.endRow; row++) {
        const column = row === match.startRow ? match.startCol : 0,
          end = row === match.endRow ? match.endCol : terminal.cols - 1;
        decorations.push({
          line: row,
          column,
          length: end - column + 1,
          background: 'rgba(218,161,0,0.5)',
        });
      }
    }
    terminal.setSearchDecorations(decorations);
    this.results.fire({
      resultIndex: match ? this.advancedIndex : -1,
      resultCount: this.advancedMatches.length,
      truncated: this.advancedTruncated,
    });
    return !!match;
  }

  clearDecorations(): void {
    this.text = '';
    this.generation++;
    this.running = false;
    this.advancedKey = '';
    if (!this.search?.disposed) this.search?.setNeedle('');
    this.terminal?.setSearchDecorations([]);
    this.results.fire({ resultIndex: -1, resultCount: 0 });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.cancelTimer?.();
    this.subscription?.dispose();
    this.search?.dispose();
    this.terminal?.setSearchDecorations([]);
    this.results.dispose();
    this.terminal = undefined;
  }
}
