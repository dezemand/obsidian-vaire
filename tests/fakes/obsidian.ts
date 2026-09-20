// A minimal *runtime* stand-in for the 'obsidian' npm package (types-only — see package.json:
// there is no real Obsidian runtime available under `bun test`). This implements just enough
// of the API surface `src/**` actually touches while `VairePlugin.onload()` runs, plus the
// classes/components extended or instantiated elsewhere in the import graph (so `class X
// extends Y` at module scope doesn't throw even for a feature this smoke test never exercises).
//
// Not a faithful Obsidian reimplementation — no rendering, no real views, no persistence beyond
// an in-memory `data.json` stand-in. Deliberately dumb: DOM-touching code should "just work"
// against a real (happy-dom) `document`, and everything else is the smallest stub that keeps
// `onload`/`onunload` from throwing. See tests/plugin-load.test.ts for how this is wired in via
// `mock.module('obsidian', ...)`.
//
// Type-checking note: `tsc` checks `src/**` against the *real* `obsidian` package in
// node_modules (types-only), never against this file — `mock.module` is a runtime-only
// substitution bun/test performs, invisible to the type checker. So nothing here needs to
// structurally match obsidian.d.ts; it only needs to behave correctly at runtime.

// ---- vault files ------------------------------------------------------------------------------

export class TAbstractFile {
  vault: unknown;
  path: string;
  name: string;
  parent: TFolder | null = null;

  constructor(path: string) {
    this.path = path;
    const slash = path.lastIndexOf('/');
    this.name = slash >= 0 ? path.slice(slash + 1) : path;
  }
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  stat = { ctime: 0, mtime: 0, size: 0 };

  constructor(path: string) {
    super(path);
    const dot = this.name.lastIndexOf('.');
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : '';
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === '' || this.path === '/';
  }
}

// ---- filesystem adapter -------------------------------------------------------------------

export class FileSystemAdapter {
  constructor(private readonly basePath: string) {}
  getBasePath(): string {
    return this.basePath;
  }
}

// ---- tiny pub/sub, shared by Events / Vault / MetadataCache / Workspace -----------------------

interface EventRef {
  name: string;
  cb: (...args: unknown[]) => unknown;
}

class Emitter {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();

  on(name: string, cb: (...args: unknown[]) => unknown): EventRef {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(cb);
    return { name, cb };
  }

  off(name: string, cb: (...args: unknown[]) => unknown): void {
    this.listeners.get(name)?.delete(cb);
  }

  offref(ref: EventRef): void {
    this.listeners.get(ref.name)?.delete(ref.cb);
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(name) ?? []) cb(...args);
  }
}

export class Events extends Emitter {}

// ---- Notice -------------------------------------------------------------------------------

export class Notice {
  messageEl: HTMLElement;
  constructor(message: string | DocumentFragment, _duration?: number) {
    this.messageEl = document.createElement('div');
    if (typeof message === 'string') this.messageEl.setText(message);
    else this.messageEl.appendChild(message);
  }
  hide(): void {}
  setMessage(): this {
    return this;
  }
}

// ---- App / Vault / MetadataCache / Workspace -----------------------------------------------

export class Vault extends Emitter {
  adapter: FileSystemAdapter;
  private readonly filesByPath = new Map<string, TFile>();

  constructor(basePath: string) {
    super();
    this.adapter = new FileSystemAdapter(basePath);
  }

  getFiles(): TFile[] {
    return [...this.filesByPath.values()];
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === 'md');
  }

  getName(): string {
    return 'smoke-test-vault';
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.filesByPath.get(path) ?? null;
  }

  async read(file: TFile): Promise<string> {
    return (file as unknown as { __content?: string }).__content ?? '';
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }

  async create(path: string, data: string): Promise<TFile> {
    const file = new TFile(path);
    (file as unknown as { __content: string }).__content = data;
    this.filesByPath.set(path, file);
    this.trigger('create', file);
    return file;
  }

  async createFolder(path: string): Promise<TFolder> {
    return new TFolder(path);
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const next = fn((file as unknown as { __content?: string }).__content ?? '');
    (file as unknown as { __content: string }).__content = next;
    return next;
  }

  async modify(file: TFile, data: string): Promise<void> {
    (file as unknown as { __content: string }).__content = data;
  }
}

export class MetadataCache extends Emitter {
  getFileCache(_file: TFile): unknown {
    return null;
  }
  getCache(_path: string): unknown {
    return null;
  }
}

class FakeWorkspaceLeaf {
  view: unknown = null;
  private state: { type?: string; state?: unknown } = {};

  async setViewState(state: { type: string; active?: boolean; state?: unknown }): Promise<void> {
    this.state = state;
  }
  getViewState(): { type?: string; state?: unknown } {
    return this.state;
  }
  async openFile(_file: TFile): Promise<void> {}
  detach(): void {}
}

export class WorkspaceLeaf extends FakeWorkspaceLeaf {}

export class Workspace extends Emitter {
  onLayoutReady(cb: () => void): void {
    // Real Obsidian defers this until the initial layout has settled; there is no layout here,
    // so every registration path that gates work behind it (main.ts's packages.init(), the
    // health-check-on-load pass, registerTypeColors, registerExplorerBadges, ...) runs the
    // callback synchronously and immediately instead.
    cb();
  }

  getLeavesOfType(_type: string): WorkspaceLeaf[] {
    return [];
  }

  getActiveFile(): TFile | null {
    return null;
  }

  getActiveViewOfType<T>(_type: new (...args: never[]) => T): T | null {
    return null;
  }

  getLeaf(_newLeaf?: boolean): WorkspaceLeaf {
    return new WorkspaceLeaf();
  }

  getRightLeaf(_split?: boolean): WorkspaceLeaf | null {
    return new WorkspaceLeaf();
  }

  getLeftLeaf(_split?: boolean): WorkspaceLeaf | null {
    return new WorkspaceLeaf();
  }

  async revealLeaf(_leaf: WorkspaceLeaf): Promise<void> {}

  updateOptions(): void {}
}

export class App {
  vault: Vault;
  metadataCache: MetadataCache;
  workspace: Workspace;
  fileManager: {
    renameFile: (file: TAbstractFile, newPath: string) => Promise<void>;
    processFrontMatter: (file: TFile, fn: (fm: Record<string, unknown>) => void) => Promise<void>;
    trashFile: (file: TAbstractFile) => Promise<void>;
  };

  constructor(basePath: string) {
    this.vault = new Vault(basePath);
    this.metadataCache = new MetadataCache();
    this.workspace = new Workspace();
    this.fileManager = {
      renameFile: async (file, newPath) => {
        (file as { path: string }).path = newPath;
      },
      processFrontMatter: async (_file, fn) => {
        fn({});
      },
      trashFile: async () => {},
    };
  }
}

// ---- DOM component builders (Setting and friends) ----------------------------------------

type ChangeHandler<T> = (value: T) => unknown;

export class TextComponent {
  inputEl: HTMLInputElement;
  private value = '';
  private changeHandler: ChangeHandler<string> | null = null;

  constructor(containerEl: HTMLElement) {
    this.inputEl = document.createElement('input');
    this.inputEl.type = 'text';
    containerEl.appendChild(this.inputEl);
  }
  setValue(value: string): this {
    this.value = value;
    this.inputEl.value = value;
    return this;
  }
  getValue(): string {
    return this.value;
  }
  setPlaceholder(text: string): this {
    this.inputEl.setAttribute('placeholder', text);
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.inputEl.disabled = disabled;
    return this;
  }
  onChange(cb: ChangeHandler<string>): this {
    this.changeHandler = cb;
    return this;
  }
  /** Test helper, not part of the real API: simulates the user typing. */
  __setUserValue(value: string): void {
    this.setValue(value);
    void this.changeHandler?.(value);
  }
}

export class TextAreaComponent extends TextComponent {}

export class ToggleComponent {
  toggleEl: HTMLElement;
  private value = false;
  private changeHandler: ChangeHandler<boolean> | null = null;

  constructor(containerEl: HTMLElement) {
    this.toggleEl = document.createElement('div');
    containerEl.appendChild(this.toggleEl);
  }
  setValue(value: boolean): this {
    this.value = value;
    return this;
  }
  getValue(): boolean {
    return this.value;
  }
  setDisabled(_disabled: boolean): this {
    return this;
  }
  setTooltip(): this {
    return this;
  }
  onChange(cb: ChangeHandler<boolean>): this {
    this.changeHandler = cb;
    return this;
  }
  __setUserValue(value: boolean): void {
    this.setValue(value);
    void this.changeHandler?.(value);
  }
}

export class DropdownComponent {
  selectEl: HTMLSelectElement;
  private value = '';
  private changeHandler: ChangeHandler<string> | null = null;

  constructor(containerEl: HTMLElement) {
    this.selectEl = document.createElement('select');
    containerEl.appendChild(this.selectEl);
  }
  addOption(value: string, display: string): this {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = display;
    this.selectEl.appendChild(option);
    return this;
  }
  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options)) this.addOption(value, display);
    return this;
  }
  setValue(value: string): this {
    this.value = value;
    this.selectEl.value = value;
    return this;
  }
  getValue(): string {
    return this.value;
  }
  setDisabled(_disabled: boolean): this {
    return this;
  }
  onChange(cb: ChangeHandler<string>): this {
    this.changeHandler = cb;
    return this;
  }
  __setUserValue(value: string): void {
    this.setValue(value);
    void this.changeHandler?.(value);
  }
}

export class ButtonComponent {
  buttonEl: HTMLElement;
  private clickHandler: (() => unknown) | null = null;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = document.createElement('button');
    containerEl.appendChild(this.buttonEl);
  }
  setButtonText(text: string): this {
    this.buttonEl.setText(text);
    return this;
  }
  setIcon(_icon: string): this {
    return this;
  }
  setTooltip(_text: string): this {
    return this;
  }
  setCta(): this {
    return this;
  }
  setWarning(): this {
    return this;
  }
  setDisabled(disabled: boolean): this {
    (this.buttonEl as HTMLButtonElement).disabled = disabled;
    return this;
  }
  onClick(cb: () => unknown): this {
    this.clickHandler = cb;
    this.buttonEl.addEventListener('click', () => void this.clickHandler?.());
    return this;
  }
  __click(): void {
    void this.clickHandler?.();
  }
}

export class Setting {
  settingEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
    const info = this.settingEl.createDiv({ cls: 'setting-item-info' });
    this.nameEl = info.createDiv({ cls: 'setting-item-name' });
    this.descEl = info.createDiv({ cls: 'setting-item-description' });
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
  }
  setName(name: string): this {
    this.nameEl.setText(name);
    return this;
  }
  setDesc(desc: string | DocumentFragment): this {
    this.descEl.empty();
    if (typeof desc === 'string') this.descEl.setText(desc);
    else this.descEl.appendChild(desc);
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.addClass(cls);
    return this;
  }
  setTooltip(): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  addText(cb: (c: TextComponent) => void): this {
    cb(new TextComponent(this.controlEl));
    return this;
  }
  addTextArea(cb: (c: TextAreaComponent) => void): this {
    cb(new TextAreaComponent(this.controlEl));
    return this;
  }
  addToggle(cb: (c: ToggleComponent) => void): this {
    cb(new ToggleComponent(this.controlEl));
    return this;
  }
  addDropdown(cb: (c: DropdownComponent) => void): this {
    cb(new DropdownComponent(this.controlEl));
    return this;
  }
  addButton(cb: (c: ButtonComponent) => void): this {
    cb(new ButtonComponent(this.controlEl));
    return this;
  }
  addExtraButton(cb: (c: ButtonComponent) => void): this {
    cb(new ButtonComponent(this.controlEl));
    return this;
  }
}

// ---- Plugin base classes --------------------------------------------------------------------

export interface Command {
  id: string;
  name: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean;
  editorCallback?: (...args: unknown[]) => unknown;
  editorCheckCallback?: (checking: boolean, editor: unknown, ctx: unknown) => boolean;
  hotkeys?: unknown[];
}

export class Component {
  private readonly cleanups: Array<() => void> = [];
  private readonly children: Component[] = [];

  load(): void {}
  onload(): void {}
  unload(): void {
    this.onunload();
    for (const child of this.children.splice(0)) child.unload();
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
  }
  onunload(): void {}

  addChild<T extends Component>(child: T): T {
    this.children.push(child);
    child.load();
    return child;
  }
  removeChild<T extends Component>(child: T): T {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.unload();
    return child;
  }

  register(cb: () => void): void {
    this.cleanups.push(cb);
  }
  registerEvent(ref: EventRef): void {
    this.cleanups.push(() => {
      // Best-effort unregister — the concrete emitter's `offref` already no-ops on an unknown
      // ref, so this doesn't need to know which emitter `ref` came from.
      void ref;
    });
  }
  registerDomEvent(el: EventTarget, type: string, cb: (...args: unknown[]) => unknown, options?: unknown): void {
    el.addEventListener(type, cb as EventListener, options as AddEventListenerOptions);
    this.cleanups.push(() => el.removeEventListener(type, cb as EventListener, options as EventListenerOptions));
  }
  registerInterval(id: number): number {
    this.cleanups.push(() => window.clearInterval(id));
    return id;
  }
}

export class Plugin extends Component {
  app: App;
  manifest: unknown;
  private data: unknown = null;
  private readonly commands: Command[] = [];
  private readonly viewFactories = new Map<string, (leaf: WorkspaceLeaf) => unknown>();
  private readonly viewTypeRegistrations: string[] = [];
  private readonly settingTabs: unknown[] = [];

  constructor(app: App, manifest: unknown) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  async loadData(): Promise<unknown> {
    return this.data;
  }
  async saveData(data: unknown): Promise<void> {
    this.data = data;
  }

  addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }
  /** Test helper (not part of the real API): every command registered via `addCommand`, in
   *  registration order — used to assert there are no duplicate ids. */
  __commands(): Command[] {
    return this.commands;
  }

  addRibbonIcon(_icon: string, title: string, cb: (ev: MouseEvent) => unknown): HTMLElement {
    const el = document.createElement('div');
    el.addClass('side-dock-ribbon-action');
    el.setAttribute('aria-label', title);
    el.addEventListener('click', cb as EventListener);
    return el;
  }

  addStatusBarItem(): HTMLElement {
    const el = document.createElement('div');
    el.addClass('status-bar-item');
    return el;
  }

  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
  }
  __settingTabs(): unknown[] {
    return this.settingTabs;
  }

  registerView(type: string, factory: (leaf: WorkspaceLeaf) => unknown): void {
    // Real Obsidian throws synchronously on a duplicate registration; deliberately *not*
    // replicating that here so a duplicate doesn't abort `onload()` partway through and mask
    // whatever else might be wrong — `__viewTypeRegistrations()` below lets the test assert
    // uniqueness on its own terms, with every offending type listed at once.
    this.viewFactories.set(type, factory);
    this.viewTypeRegistrations.push(type);
  }
  /** Test helper: every `registerView` type argument, in call order (including duplicates). */
  __viewTypeRegistrations(): string[] {
    return this.viewTypeRegistrations;
  }

  registerEditorExtension(_extension: unknown): void {}
  registerEditorSuggest(_suggest: unknown): void {}
  registerMarkdownPostProcessor(fn: (...args: unknown[]) => unknown, _sortOrder?: number): { sortOrder: number } {
    void fn;
    return { sortOrder: 0 };
  }
  registerMarkdownCodeBlockProcessor(
    _language: string,
    fn: (...args: unknown[]) => unknown,
    _sortOrder?: number,
  ): { sortOrder: number } {
    void fn;
    return { sortOrder: 0 };
  }
  registerHoverLinkSource(_id: string, _info: unknown): void {}
}

export class PluginSettingTab {
  app: App;
  containerEl: HTMLElement;

  constructor(app: App, _plugin: unknown) {
    this.app = app;
    this.containerEl = document.createElement('div');
  }
  display(): void {}
  hide(): void {}
}

// ---- Views / modals / suggesters (extended, sometimes instantiated) --------------------------

export class ItemView extends Component {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  icon = '';

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = (leaf as unknown as { app?: App }).app ?? new App('/tmp');
    this.containerEl = document.createElement('div');
    this.contentEl = this.containerEl.createDiv();
  }
  getViewType(): string {
    return 'fake-view';
  }
  getDisplayText(): string {
    return '';
  }
  addAction(_icon: string, _title: string, cb: (ev: MouseEvent) => unknown): HTMLElement {
    const el = document.createElement('div');
    el.addEventListener('click', cb as EventListener);
    return el;
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class MarkdownView extends ItemView {
  editor: unknown = null;
  file: TFile | null = null;
}

export class Modal extends Component {
  app: App;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  titleEl: HTMLElement;
  scope: unknown = {};

  constructor(app: App) {
    super();
    this.app = app;
    this.containerEl = document.createElement('div');
    this.titleEl = this.containerEl.createDiv();
    this.contentEl = this.containerEl.createDiv();
  }
  setTitle(title: string): this {
    this.titleEl.setText(title);
    return this;
  }
  open(): void {
    this.load();
    this.onOpen();
  }
  close(): void {
    this.onClose();
    this.unload();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class SuggestModal<T> extends Modal {
  limit = 100;
  getSuggestions(_query: string): T[] {
    return [];
  }
  renderSuggestion(_value: T, _el: HTMLElement): void {}
  onChooseSuggestion(_value: T, _evt: MouseEvent | KeyboardEvent): void {}
}

export class FuzzySuggestModal<T> extends SuggestModal<T> {
  getItems(): T[] {
    return [];
  }
  getItemText(_item: T): string {
    return '';
  }
  onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
}

export class EditorSuggest<T> {
  app: App;
  limit = 100;
  constructor(app: App) {
    this.app = app;
  }
  onTrigger(_cursor: unknown, _editor: unknown, _file: unknown): unknown {
    return null;
  }
  getSuggestions(_context: unknown): T[] | Promise<T[]> {
    return [];
  }
  renderSuggestion(_value: T, _el: HTMLElement): void {}
  selectSuggestion(_value: T, _evt: MouseEvent | KeyboardEvent): void {}
}

export class MarkdownRenderChild extends Component {
  containerEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.containerEl = containerEl;
  }
}

export const MarkdownRenderer = {
  async render(
    _app: App,
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _component: Component,
  ): Promise<void> {
    el.setText(markdown);
  },
};

export class Menu {
  addItem(cb: (item: MenuItem) => void): this {
    cb(new MenuItem());
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(_ev: MouseEvent): void {}
  showAtPosition(_pos: { x: number; y: number }): void {}
}

class MenuItem {
  setTitle(_title: string): this {
    return this;
  }
  setIcon(_icon: string): this {
    return this;
  }
  onClick(_cb: (ev: MouseEvent) => unknown): this {
    return this;
  }
}

// ---- misc functions/objects -----------------------------------------------------------------

export function setIcon(_el: HTMLElement, _icon: string): void {}

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isMacOS: false,
  isWin: false,
  isLinux: true,
};

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

export async function requestUrl(_opts: unknown): Promise<RequestUrlResponse> {
  return { status: 0, headers: {}, text: '', json: null, arrayBuffer: new ArrayBuffer(0) };
}

export function normalizePath(path: string): string {
  const collapsed = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const trimmed = collapsed.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed || '/';
}

export function debounce<F extends (...args: never[]) => unknown>(
  fn: F,
  delay = 0,
  resetTimer = false,
): F & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = ((...args: Parameters<F>) => {
    if (timer) {
      if (!resetTimer) return;
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  }) as F & { cancel: () => void };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

export interface FuzzyMatch<T> {
  item: T;
  match: { score: number; matches: [number, number][] };
}

/** A deliberately simple case-insensitive substring matcher — real Obsidian's is a proper fuzzy
 *  scorer, but nothing in this test suite exercises match quality, only that the function exists
 *  and returns the shape `renderMatches`/callers expect. */
export function prepareFuzzySearch(
  query: string,
): (text: string) => { score: number; matches: [number, number][] } | null {
  const needle = query.toLowerCase();
  return (text: string) => {
    const haystack = text.toLowerCase();
    const idx = haystack.indexOf(needle);
    if (idx === -1) return null;
    return { score: -idx, matches: needle ? [[idx, idx + needle.length]] : [] };
  };
}

export function renderMatches(
  el: HTMLElement,
  text: string,
  matches: [number, number][] | null,
  _offset?: number,
): void {
  el.empty();
  if (!matches || matches.length === 0) {
    el.setText(text);
    return;
  }
  el.setText(text); // good enough for a load-time smoke test — no highlighting fidelity needed
}

/** Not a real CodeMirror `StateField` — nothing in this test suite ever calls
 *  `view.state.field(editorInfoField, ...)` against a live `EditorState` (that only happens
 *  inside a CM6 lint source, which requires a real mounted editor this suite never creates), so
 *  this only has to exist as a value for `import { editorInfoField } from 'obsidian'` to resolve
 *  at module load. */
export const editorInfoField = {};

// ---- test-only factory ------------------------------------------------------------------------

/** Not part of the 'obsidian' API — a convenience for tests/plugin-load.test.ts to build a fresh
 *  `App` wired to a fake `FileSystemAdapter` base path. */
export function createFakeApp(basePath: string): App {
  return new App(basePath);
}
