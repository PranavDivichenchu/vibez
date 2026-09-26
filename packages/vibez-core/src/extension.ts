import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph, layoutGraph, type Graph } from '@vibez/core';
import { startCapture, type CaptureHandle } from '@vibez/capture';

/**
 * A `.flow` file holds a graph. Registering it as a custom editor means tabs,
 * splits, back/forward and side-by-side with code all work without us writing
 * any of it — VS Code already has the best code viewer in the building.
 */
class GraphEditor implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): void {
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'webview');
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] };

    const post = (): void => {
      let graph: Graph;
      try {
        graph = JSON.parse(document.getText()) as Graph;
      } catch {
        return;
      }
      void panel.webview.postMessage({ type: 'view', view: { graph, layout: layoutGraph(graph) } });
    };

    panel.webview.html = this.html(panel.webview, root);

    const changed = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === document.uri.toString()) post();
    });
    panel.onDidDispose(() => changed.dispose());

    panel.webview.onDidReceiveMessage((message: { type: string; file?: string; line?: number }) => {
      if (message.type !== 'open' || message.file === undefined) return;
      void this.reveal(message.file, message.line ?? 1);
    });

    post();
  }

  /** Clicking a node opens the real file at the real line, beside the graph. */
  private async reveal(file: string, line: number): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) return;
    const uri = vscode.Uri.joinPath(folder.uri, file);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const at = new vscode.Position(Math.max(0, line - 1), 0);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        selection: new vscode.Selection(at, at),
      });
    } catch {
      void vscode.window.showWarningMessage(`Vibez: could not open ${file}`);
    }
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const uri = (name: string): vscode.Uri => webview.asWebviewUri(vscode.Uri.joinPath(root, name));
    const nonce = Math.random().toString(36).slice(2);
    return readFileSync(join(root.fsPath, 'index.html'), 'utf8')
      .replace('./graph.css', uri('graph.css').toString())
      .replace('<script src="./graph.js"></script>', `<script nonce="${nonce}" src="${uri('graph.js').toString()}"></script>`);
  }
}

let capture: CaptureHandle | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('vibez.graph', new GraphEditor(context), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (workspace === undefined) return;
  const folder = workspace.uri;

  const config = vscode.workspace.getConfiguration('vibez');
  const flow = vscode.Uri.joinPath(folder, '.vibez', 'flows', 'default.flow');

  capture = await startCapture({
    port: config.get<number>('otlpPort') ?? 4318,
    dbPath: vscode.Uri.joinPath(folder, '.vibez', 'spans.db').fsPath,
    mode: config.get<'rough' | 'measured'>('mode') ?? 'rough',
    onBatch: () => { void writeFlow(); },
  });

  let pending: NodeJS.Timeout | undefined;
  async function writeFlow(): Promise<void> {
    // Traces arrive in bursts; rebuilding per batch would thrash the canvas.
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      void (async () => {
        if (capture === undefined) return;
        const graph = buildGraph(capture.store.recent(50), {
          mode: config.get<'rough' | 'measured'>('mode') ?? 'rough',
        });
        if (graph.nodes.length === 0) return;
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder, '.vibez', 'flows'));
        await vscode.workspace.fs.writeFile(flow, Buffer.from(JSON.stringify(graph, null, 2)));
      })();
    }, 400);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('vibez.openGraph', async () => {
      await writeFlow();
      await vscode.commands.executeCommand('vscode.openWith', flow, 'vibez.graph');
    }),
  );
}

export async function deactivate(): Promise<void> {
  await capture?.close();
  capture = undefined;
}
