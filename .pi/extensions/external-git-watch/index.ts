import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderDiff } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";

const POLL_INTERVAL_MS = 1000;
const DEBOUNCE_MS = 250;
const MAX_DIFF_CHARS = 40_000;
const MUTATION_TOOLS = new Set(["edit", "write", "bash"]);

type Snapshot = Map<string, string>;

type ExternalChangeMessageDetails = {
	repoRoot: string;
	files: string[];
	diff: string;
	truncated: boolean;
	source: "external";
	detectedAt: number;
};

type PendingExternalChange = {
	details: ExternalChangeMessageDetails;
	signature: string;
	snapshot: Snapshot;
};

type RepoSnapshot = {
	root: string;
	trackedFiles: string[];
	baseline: Snapshot;
	lastSignature: string | undefined;
	pending: PendingExternalChange | undefined;
	watcher: fs.FSWatcher | undefined;
	poller: NodeJS.Timeout | undefined;
	debounceTimer: NodeJS.Timeout | undefined;
	scanning: boolean;
	queuedScan: boolean;
	agentActive: boolean;
	mutationDepth: number;
	mutationCallIds: Set<string>;
	ready: boolean;
	enabled: boolean;
	lastNoticeAt: number;
};

function trimTrailingNewline(text: string): string {
	return text.replace(/\n+$/g, "");
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | undefined> {
	const result = await pi.exec("git", args, { cwd, timeout: 15_000 });
	if (result.code !== 0) return undefined;
	return trimTrailingNewline(result.stdout);
}

async function findRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	return runGit(pi, cwd, ["rev-parse", "--show-toplevel"]);
}

async function getTrackedFiles(pi: ExtensionAPI, root: string): Promise<string[]> {
	const output = await runGit(pi, root, ["ls-files"]);
	if (!output) return [];
	return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function readTextFile(filePath: string): Promise<string> {
	try {
		return await fs.promises.readFile(filePath, "utf8");
	} catch {
		return "";
	}
}

async function readSnapshot(root: string, files: string[]): Promise<Snapshot> {
	const entries = await Promise.all(
		files.map(async (file) => [file, await readTextFile(path.join(root, file))] as const),
	);
	return new Map(entries);
}

async function renderFileDiff(
	pi: ExtensionAPI,
	root: string,
	filePath: string,
	oldText: string,
	newText: string,
): Promise<string> {
	if (oldText === newText) return "";

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-external-git-watch-"));
	const oldFile = path.join(tmpDir, "old.txt");
	const newFile = path.join(tmpDir, "new.txt");

	try {
		fs.writeFileSync(oldFile, oldText, "utf8");
		fs.writeFileSync(newFile, newText, "utf8");

		const result = await pi.exec(
			"git",
			["diff", "--no-index", "--no-ext-diff", "--unified=4", "--", oldFile, newFile],
			{ cwd: root, timeout: 15_000 },
		);

		if (result.code !== 0 && result.code !== 1) {
			return "";
		}

		let diff = trimTrailingNewline(result.stdout || result.stderr || "");
		if (!diff) return "";

		diff = diff.replace(/^diff --git .*$/m, `diff --git a/${filePath} b/${filePath}`);
		diff = diff.replace(/^--- .*$/m, `--- a/${filePath}`);
		diff = diff.replace(/^\+\+\+ .*$/m, `+++ b/${filePath}`);
		return diff;
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function statusText(repo: RepoSnapshot | undefined): string {
	if (!repo) return "external-git-watch: inactive";
	if (!repo.enabled) return `external-git-watch: disabled (${repo.root})`;
	return `external-git-watch: watching ${repo.root}`;
}

function makeSignature(details: ExternalChangeMessageDetails): string {
	return hashText([details.repoRoot, details.files.join("\0"), details.diff].join("\0"));
}

async function computeWorkspaceChange(
	pi: ExtensionAPI,
	root: string,
	trackedFiles: string[],
	baseline: Snapshot,
): Promise<PendingExternalChange | undefined> {
	const current = await readSnapshot(root, trackedFiles);
	const changedFiles: string[] = [];
	const diffs: string[] = [];

	for (const filePath of trackedFiles) {
		const oldText = baseline.get(filePath) ?? "";
		const newText = current.get(filePath) ?? "";
		if (oldText === newText) continue;

		const diff = await renderFileDiff(pi, root, filePath, oldText, newText);
		if (diff) {
			changedFiles.push(filePath);
			diffs.push(diff);
		}
	}

	if (changedFiles.length === 0) return undefined;

	const combinedDiff = trimTrailingNewline(diffs.join("\n\n"));
	const truncated = combinedDiff.length > MAX_DIFF_CHARS;
	const diff = truncated ? `${combinedDiff.slice(0, MAX_DIFF_CHARS)}\n\n... [diff truncated]` : combinedDiff;
	const details: ExternalChangeMessageDetails = {
		repoRoot: root,
		files: uniqueSorted(changedFiles),
		diff,
		truncated,
		source: "external",
		detectedAt: Date.now(),
	};

	return {
		details,
		signature: makeSignature(details),
		snapshot: current,
	};
}

function renderExternalChangeMessage(content: string, theme: any, expanded: boolean): Box {
	const lines = content.split("\n");
	const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
	const removals = lines.filter((line) => line.startsWith("-") && !line.startsWith("---"));

	const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
	const container = new Container();

	let header = theme.fg("toolTitle", theme.bold("external git change"));
	header += theme.fg("dim", "  ");
	header += theme.fg("success", `+${additions.length}`);
	header += theme.fg("dim", " / ");
	header += theme.fg("error", `-${removals.length}`);
	container.addChild(new Text(header, 0, 0));

	if (expanded) {
		const rendered = renderDiff(content).split("\n");
		container.addChild(new Spacer(1));
		for (const line of rendered.slice(0, 30)) {
			container.addChild(new Text(line, 0, 0));
		}
		if (rendered.length > 30) {
			container.addChild(new Text(theme.fg("muted", `... ${rendered.length - 30} more diff lines`), 0, 0));
		}
	}

	box.addChild(container);
	return box;
}

export default function externalGitWatchExtension(pi: ExtensionAPI) {
	let repo: RepoSnapshot | undefined;

	const cleanup = () => {
		if (!repo) return;
		if (repo.watcher) repo.watcher.close();
		if (repo.poller) clearInterval(repo.poller);
		if (repo.debounceTimer) clearTimeout(repo.debounceTimer);
		repo = undefined;
	};

	const scheduleScan = () => {
		if (!repo || !repo.ready || !repo.enabled) return;
		if (repo.debounceTimer) clearTimeout(repo.debounceTimer);
		repo.debounceTimer = setTimeout(() => {
			void scan("debounced");
		}, DEBOUNCE_MS);
	};

	const refreshBaseline = async () => {
		if (!repo) return;
		repo.baseline = await readSnapshot(repo.root, repo.trackedFiles);
		repo.lastSignature = undefined;
		repo.pending = undefined;
	};

	const updateStatus = (ctx?: any) => {
		if (!ctx?.ui) return;
		ctx.ui.setStatus("external-git-watch", statusText(repo));
	};

	const setEnabled = async (enabled: boolean, ctx?: any) => {
		if (!repo) return;
		repo.enabled = enabled;
		if (enabled) {
			await refreshBaseline();
			scheduleScan();
		} else {
			if (repo.debounceTimer) clearTimeout(repo.debounceTimer);
			repo.debounceTimer = undefined;
		}
		updateStatus(ctx);
	};

	const scan = async (_reason: string) => {
		if (!repo || !repo.ready || !repo.enabled || repo.scanning) {
			if (repo) repo.queuedScan = true;
			return;
		}

		repo.scanning = true;
		try {
			do {
				repo.queuedScan = false;

				if (repo.mutationDepth > 0) {
					await refreshBaseline();
					continue;
				}

				const pending = await computeWorkspaceChange(pi, repo.root, repo.trackedFiles, repo.baseline);
				if (!pending) continue;
				if (pending.signature === repo.lastSignature) continue;

				repo.lastSignature = pending.signature;
				repo.pending = pending;
			} while (repo.queuedScan);
		} finally {
			repo.scanning = false;
		}
	};

	pi.registerMessageRenderer("external-git-change", (message, { expanded }, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return renderExternalChangeMessage(content, theme, expanded);
	});

	pi.on("session_start", async (_event, ctx) => {
		cleanup();

		const root = await findRepoRoot(pi, ctx.cwd);
		if (!root) {
			ctx.ui.notify("external-git-watch disabled: current directory is not a git repo", "warning");
			ctx.ui.setStatus("external-git-watch", "external-git-watch: inactive");
			return;
		}

		const trackedFiles = await getTrackedFiles(pi, root);
		repo = {
			root,
			trackedFiles,
			baseline: await readSnapshot(root, trackedFiles),
			lastSignature: undefined,
			pending: undefined,
			watcher: undefined,
			poller: undefined,
			debounceTimer: undefined,
			scanning: false,
			queuedScan: false,
			agentActive: false,
			mutationDepth: 0,
			mutationCallIds: new Set<string>(),
			ready: false,
			enabled: true,
			lastNoticeAt: 0,
		};

		repo.ready = true;

		try {
			repo.watcher = fs.watch(root, { recursive: true }, () => {
				scheduleScan();
			});
		} catch {
			// Recursive watch is not always available; polling remains as fallback.
		}

		try {
			repo.poller = setInterval(() => {
				void scan("poll");
			}, POLL_INTERVAL_MS);
		} catch {
			// Ignore poller setup failures; scan on agent events still works.
		}

		ctx.ui.setStatus("external-git-watch", statusText(repo));
		ctx.ui.notify(`external-git-watch active in ${root}`, "info");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("external-git-watch", "external-git-watch: inactive");
		cleanup();
	});

	pi.on("context", async (event, _ctx) => {
		if (!repo?.pending) return { messages: event.messages };
		const pending = repo.pending;
		repo.pending = undefined;
		repo.baseline = pending.snapshot;
		repo.lastSignature = pending.signature;
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: "external-git-change",
					content: pending.details.diff,
					display: true,
					details: pending.details,
				},
			],
		};
	});

	pi.on("agent_start", async () => {
		if (repo) repo.agentActive = true;
	});

	pi.on("agent_end", async () => {
		if (repo) repo.agentActive = false;
	});

	pi.on("tool_execution_start", async (event) => {
		if (!repo || !MUTATION_TOOLS.has(event.toolName)) return;
		repo.mutationCallIds.add(event.toolCallId);
		repo.mutationDepth += 1;
	});

	pi.on("tool_execution_end", async (event) => {
		if (!repo || !repo.mutationCallIds.has(event.toolCallId)) return;
		repo.mutationCallIds.delete(event.toolCallId);
		repo.mutationDepth = Math.max(0, repo.mutationDepth - 1);
		if (repo.mutationDepth === 0) {
			void refreshBaseline();
		}
	});

	pi.on("tool_result", async (event) => {
		if (!repo || event.isError) return;
		if (!MUTATION_TOOLS.has(event.toolName)) return;
		if (repo.mutationDepth === 0) {
			void scan("tool-result");
		}
	});

	pi.registerCommand("external-watch", {
		description: "Control the external git change watcher: /external-watch status|on|off|rescan",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "status") {
				ctx.ui.notify(statusText(repo), "info");
				return;
			}
			if (!repo) {
				ctx.ui.notify("external-git-watch is not active in this session", "warning");
				return;
			}
			if (action === "on") {
				await setEnabled(true, ctx);
				ctx.ui.notify("external-git-watch enabled", "success");
				return;
			}
			if (action === "off") {
				await setEnabled(false, ctx);
				ctx.ui.notify("external-git-watch disabled", "warning");
				return;
			}
			if (action === "rescan") {
				await refreshBaseline();
				await scan("manual-rescan");
				ctx.ui.notify("external-git-watch rescanned", "info");
				return;
			}
			ctx.ui.notify("Usage: /external-watch status|on|off|rescan", "warning");
		},
	});
}
