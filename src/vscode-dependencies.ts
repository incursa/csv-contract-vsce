import * as vscode from "vscode";

/** Exact per-file watchers also cover dependencies outside workspace roots. */
export class DependencyWatchers implements vscode.Disposable {
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  constructor(private readonly changed: (uri: vscode.Uri) => void) {}
  set(locations: Iterable<string>): void {
    const wanted = new Set(locations);
    for (const [key, watcher] of this.watchers) if (!wanted.has(key)) { watcher.dispose(); this.watchers.delete(key); }
    for (const key of wanted) {
      if (this.watchers.has(key)) continue;
      const uri = vscode.Uri.parse(key);
      const name = uri.path.split("/").pop();
      if (!name || uri.scheme === "http" || uri.scheme === "https") continue;
      const pattern = [...name].map(c => "[]{}*?".includes(c) ? `[${c}]` : c).join("");
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, ".."), pattern));
      watcher.onDidChange(this.changed); watcher.onDidCreate(this.changed); watcher.onDidDelete(this.changed);
      this.watchers.set(key, watcher);
    }
  }
  dispose(): void { this.watchers.forEach(w => w.dispose()); this.watchers.clear(); }
}
