import { EventEmitter } from '../event-emitter';
import type { GhosttyTerminal } from '../ghostty';
import type { ITerminalAddon, ITerminalCore, IDisposable } from '../interfaces';
import type { TerminalSearch } from '../search';
import type { Terminal } from '../terminal';

export interface SearchResults {
  resultIndex: number;
  resultCount: number;
}
/** Focused-terminal literal search. findNext moves towards older output. */
export class SearchAddon implements ITerminalAddon {
  private terminal?: Terminal;
  private wasm?: GhosttyTerminal;
  private search?: TerminalSearch;
  private subscription?: IDisposable;
  private cancelTimer?: () => void;
  private text = '';
  private disposed = false;
  private results = new EventEmitter<SearchResults>();
  readonly onDidChangeResults = this.results.event;
  activate(terminal: ITerminalCore): void {
    this.terminal = terminal as Terminal;
    this.subscription = this.terminal.onWriteParsed(() => {
      if (!this.text || this.cancelTimer) return;
      const update = () => {
        this.cancelTimer = undefined;
        if (!this.disposed) this.find(this.text, undefined);
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
  refresh(text: string): boolean {
    return this.find(text, undefined);
  }
  findNext(text: string): boolean {
    return this.find(text, true);
  }
  findPrevious(text: string): boolean {
    return this.find(text, false);
  }
  private find(text: string, older: boolean | undefined): boolean {
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
  clearDecorations(): void {
    this.text = '';
    if (!this.search?.disposed) this.search?.setNeedle('');
    this.terminal?.setSearchDecorations([]);
    this.results.fire({ resultIndex: -1, resultCount: 0 });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer?.();
    this.subscription?.dispose();
    this.search?.dispose();
    this.terminal?.setSearchDecorations([]);
    this.results.dispose();
    this.terminal = undefined;
  }
}
