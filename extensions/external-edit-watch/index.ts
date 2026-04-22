import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderDiff } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";

const POLL_INTERVAL_MS = 1000;
const DEBOUNCE_MS = 250;
const MUTATION_TOOLS = new Set(["edit", "write", "bash"]);

type Snapshot = Map<string, string>;

type ExternalEditMessageDetails = {
	repoRoot: string;
	filePath: string;
	diff: string;
	source: "external";
	detectedAt: number;
};

type RepoSnapshot = {
	root: string;
	trackedFiles: string[];
	baseline: Snapshot;
	watcher: fs.FSWatcher | undefined;
	poller: NodeJS.Timeout | undefined;
	debounceTimer: NodeJS.Timeout | undefined;
	scanning: boolean;
	queuedScan: boolean;
	mutationDepth: number;
	mutationCallIds: Set<string>;
	ready: boolean;
	enabled: boolean;
};

function trimTrailingNewline(text: string): string {
	return text.replace(/\n+$/g, "");
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

async function refreshTrackedFiles(pi: ExtensionAPI, repo: RepoSnapshot): Promise<void> {
	const trackedFiles = await getTrackedFiles(pi, repo.root);
	const currentTracked = new Set(trackedFiles);
	const previousTracked = new Set(repo.trackedFiles);

	for (const filePath of trackedFiles) {
		if (previousTracked.has(filePath)) continue;
		repo.baseline.set(filePath, await readTextFile(path.join(repo.root, filePath)));
	}

	for (const filePath of repo.trackedFiles) {
		if (currentTracked.has(filePath)) continue;
		repo.baseline.delete(filePath);
	}

	repo.trackedFiles = trackedFiles;
}

function statusText(repo: RepoSnapshot | undefined, theme?: any): string | undefined {
	if (!repo) return undefined;
	if (!theme) {
		if (!repo.enabled) return "◌ collab";
		return "● collab";
	}
	if (!repo.enabled) return theme.fg("dim", "◌ collab");
	return theme.fg("accent", "●") + theme.fg("dim", " collab");
}

type DiffPart = {
	value: string;
	added?: boolean;
	removed?: boolean;
};

function splitContentLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function diffLineParts(oldContent: string, newContent: string): DiffPart[] {
	const oldLines = splitContentLines(oldContent);
	const newLines = splitContentLines(newContent);
	const rows = oldLines.length + 1;
	const cols = newLines.length + 1;
	const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

	for (let i = oldLines.length - 1; i >= 0; i--) {
		for (let j = newLines.length - 1; j >= 0; j--) {
			dp[i][j] = oldLines[i] === newLines[j]
				? dp[i + 1][j + 1] + 1
				: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const parts: Array<{ lines: string[]; added?: boolean; removed?: boolean }> = [];
	const push = (line: string, added?: boolean, removed?: boolean) => {
		const last = parts[parts.length - 1];
		if (last && last.added === added && last.removed === removed) {
			last.lines.push(line);
			return;
		}
		parts.push({ lines: [line], added, removed });
	};

	let i = 0;
	let j = 0;
	while (i < oldLines.length && j < newLines.length) {
		if (oldLines[i] === newLines[j]) {
			push(oldLines[i]);
			i++;
			j++;
			continue;
		}
		if (dp[i + 1][j] >= dp[i][j + 1]) {
			push(oldLines[i], false, true);
			i++;
		} else {
			push(newLines[j], true, false);
			j++;
		}
	}
	while (i < oldLines.length) {
		push(oldLines[i], false, true);
		i++;
	}
	while (j < newLines.length) {
		push(newLines[j], true, false);
		j++;
	}

	return parts.map((part) => ({
		value: `${part.lines.join("\n")}\n`,
		added: part.added,
		removed: part.removed,
	}));
}

function generateDiffString(oldContent: string, newContent: string, contextLines = 4): { diff: string; firstChangedLine?: number } {
	const parts = diffLineParts(oldContent, newContent);
	const output: string[] = [];
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;
	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
		const hasLeadingChange = lastWasChange;
		const hasTrailingChange = nextPartIsChange;

		if (hasLeadingChange && hasTrailingChange) {
			if (raw.length <= contextLines * 2) {
				for (const line of raw) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				const leadingLines = raw.slice(0, contextLines);
				const trailingLines = raw.slice(raw.length - contextLines);
				const skippedLines = raw.length - leadingLines.length - trailingLines.length;
				for (const line of leadingLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skippedLines;
				newLineNum += skippedLines;
				for (const line of trailingLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			}
		} else if (hasLeadingChange) {
			const shownLines = raw.slice(0, contextLines);
			const skippedLines = raw.length - shownLines.length;
			for (const line of shownLines) {
				const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
				output.push(` ${lineNum} ${line}`);
				oldLineNum++;
				newLineNum++;
			}
			if (skippedLines > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skippedLines;
				newLineNum += skippedLines;
			}
		} else if (hasTrailingChange) {
			const skippedLines = Math.max(0, raw.length - contextLines);
			if (skippedLines > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skippedLines;
				newLineNum += skippedLines;
			}
			for (const line of raw.slice(skippedLines)) {
				const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
				output.push(` ${lineNum} ${line}`);
				oldLineNum++;
				newLineNum++;
			}
		} else {
			oldLineNum += raw.length;
			newLineNum += raw.length;
		}

		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}

function countDiffLines(diff: string): { additions: number; removals: number } {
	const lines = diff.split("\n");
	let additions = 0;
	let removals = 0;
	for (const line of lines) {
		if (line.startsWith("+")) additions++;
		if (line.startsWith("-")) removals++;
	}
	return { additions, removals };
}

function buildContextMessage(filePath: string, diff: string): string {
	return `External file change detected in ${filePath}:\n\n\`\`\`text\n${diff}\n\`\`\``;
}

function buildEditLikeMessage(filePath: string, diff: string, theme: any, expanded: boolean): Container {
	const container = new Container();
	const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
	const { additions, removals } = countDiffLines(diff);
	const rendered = renderDiff(diff).split("\n");
	const previewLines = expanded ? rendered.length : Math.min(rendered.length, 20);

	let header = theme.fg("customMessageLabel", theme.bold("external edit"));
	header += " ";
	header += theme.fg("accent", filePath);
	header += theme.fg("dim", "  ");
	header += theme.fg("success", `+${additions}`);
	header += theme.fg("dim", " / ");
	header += theme.fg("error", `-${removals}`);

	box.addChild(new Text(header, 0, 0));

	if (previewLines > 0) {
		box.addChild(new Spacer(1));
		box.addChild(new Text(rendered.slice(0, previewLines).join("\n"), 0, 0));
		if (!expanded && rendered.length > previewLines) {
			box.addChild(new Spacer(1));
			box.addChild(new Text(theme.fg("muted", "..."), 0, 0));
		}
	}

	container.addChild(box);
	container.addChild(new Spacer(1));
	return container;
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
		await refreshTrackedFiles(pi, repo);
		repo.baseline = await readSnapshot(repo.root, repo.trackedFiles);
	};

	const updateStatus = (ctx?: any) => {
		if (!ctx?.ui) return;
		ctx.ui.setStatus("external-watch", statusText(repo, ctx.ui.theme));
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

				await refreshTrackedFiles(pi, repo);
				const current = await readSnapshot(repo.root, repo.trackedFiles);

				for (const filePath of repo.trackedFiles) {
					const oldText = repo.baseline.get(filePath) ?? "";
					const newText = current.get(filePath) ?? "";
					if (oldText === newText) continue;

					const generated = generateDiffString(oldText, newText);
					if (!generated.diff) continue;

					const details: ExternalEditMessageDetails = {
						repoRoot: repo.root,
						filePath,
						diff: generated.diff,
						source: "external",
						detectedAt: Date.now(),
					};

					pi.sendMessage(
						{
							customType: "external-edit",
							content: buildContextMessage(filePath, generated.diff),
							display: true,
							details,
						},
						{ deliverAs: "steer" },
					);
				}

				repo.baseline = current;
			} while (repo.queuedScan);
		} finally {
			repo.scanning = false;
		}
	};

	pi.registerMessageRenderer("external-edit", (message, { expanded }, theme) => {
		const details = message.details as ExternalEditMessageDetails | undefined;
		const filePath = details?.filePath ?? "(unknown file)";
		const diff = details?.diff ?? "";
		return buildEditLikeMessage(filePath, diff, theme, expanded);
	});

	pi.on("session_start", async (_event, ctx) => {
		cleanup();

		const root = await findRepoRoot(pi, ctx.cwd);
		if (!root) {
			ctx.ui.notify("external-watch disabled: current directory is not a git repo", "warning");
			ctx.ui.setStatus("external-watch", undefined);
			return;
		}

		const trackedFiles = await getTrackedFiles(pi, root);
		repo = {
			root,
			trackedFiles,
			baseline: await readSnapshot(root, trackedFiles),
			watcher: undefined,
			poller: undefined,
			debounceTimer: undefined,
			scanning: false,
			queuedScan: false,
			mutationDepth: 0,
			mutationCallIds: new Set<string>(),
			ready: false,
			enabled: true,
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
			// Ignore poller setup failures.
		}

		updateStatus(ctx);
		ctx.ui.notify(`external-watch active in ${root}`, "info");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("external-watch", undefined);
		cleanup();
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
		description: "Control the external watcher: /external-watch status|on|off|rescan",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "status") {
				ctx.ui.notify(statusText(repo) ?? "external-watch inactive", "info");
				return;
			}
			if (!repo) {
				ctx.ui.notify("external-watch is not active in this session", "warning");
				return;
			}
			if (action === "on") {
				await setEnabled(true, ctx);
				ctx.ui.notify("external-watch enabled", "success");
				return;
			}
			if (action === "off") {
				await setEnabled(false, ctx);
				ctx.ui.notify("external-watch disabled", "warning");
				return;
			}
			if (action === "rescan") {
				await refreshBaseline();
				ctx.ui.notify("external-watch baseline refreshed", "info");
				return;
			}
			ctx.ui.notify("Usage: /external-watch status|on|off|rescan", "warning");
		},
	});
}
