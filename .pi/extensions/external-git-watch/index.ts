import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderDiff } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { createHash } from "node:crypto";

const POLL_INTERVAL_MS = 1000;
const DEBOUNCE_MS = 250;
const MAX_DIFF_CHARS = 40_000;
const MUTATION_TOOLS = new Set(["edit", "write", "bash"]);

type RepoSnapshot = {
	root: string;
	lastSignature: string | undefined;
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

type ExternalChangeMessageDetails = {
	repoRoot: string;
	files: string[];
	diff: string;
	truncated: boolean;
	source: "external";
	detectedAt: number;
};

function trimTrailingNewline(text: string): string {
	return text.replace(/\n+$/g, "");
}

function splitLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | undefined> {
	const result = await pi.exec("git", args, { cwd, timeout: 15_000 });
	if (result.code !== 0) {
		return undefined;
	}
	return trimTrailingNewline(result.stdout);
}

async function findRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	return runGit(pi, cwd, ["rev-parse", "--show-toplevel"]);
}

async function getChangeNames(pi: ExtensionAPI, root: string): Promise<string[]> {
	const [unstaged, staged] = await Promise.all([
		runGit(pi, root, ["diff", "--name-only", "--diff-filter=ACDMR"]),
		runGit(pi, root, ["diff", "--cached", "--name-only", "--diff-filter=ACDMR"]),
	]);
	return uniqueSorted([...splitLines(unstaged ?? ""), ...splitLines(staged ?? "")]);
}

async function getDiffPayload(pi: ExtensionAPI, root: string): Promise<{ diff: string; files: string[]; truncated: boolean }> {
	const [unstagedDiff, stagedDiff] = await Promise.all([
		runGit(pi, root, ["diff", "--no-ext-diff", "--unified=4", "--diff-algorithm=histogram", "--"]),
		runGit(pi, root, ["diff", "--cached", "--no-ext-diff", "--unified=4", "--diff-algorithm=histogram", "--"]),
	]);

	const diffs = [unstagedDiff, stagedDiff].filter((diff): diff is string => Boolean(diff));
	const combined = trimTrailingNewline(diffs.join("\n\n"));
	const files = await getChangeNames(pi, root);
	const truncated = combined.length > MAX_DIFF_CHARS;
	const diff = truncated ? `${combined.slice(0, MAX_DIFF_CHARS)}\n\n... [diff truncated]` : combined;
	return { diff, files, truncated };
}

function buildMessage(details: ExternalChangeMessageDetails): string {
	const fileLines = details.files.length > 0
		? details.files.map((file) => `- ${file}`).join("\n")
		: "- (no tracked files detected; diff may be empty due to a transient state)";

	const truncatedNote = details.truncated
		? "\n\nNote: diff was truncated to keep the context manageable."
		: "";

	return [
		"External git change detected outside pi.",
		"Likely source: user, script, or another agent.",
		"",
		"Changed files:",
		fileLines,
		"",
		"Unified diff:",
		"```diff",
		details.diff || "(no diff text available)",
		"```",
		truncatedNote,
	].join("\n");
}

function statusText(repo: RepoSnapshot | undefined): string {
	if (!repo) return "external-git-watch: inactive";
	if (!repo.enabled) return `external-git-watch: disabled (${repo.root})`;
	return `external-git-watch: watching ${repo.root}`;
}

function changeSignature(details: ExternalChangeMessageDetails): string {
	return createHash("sha256")
		.update(details.repoRoot)
		.update("\0")
		.update(details.files.join("\0"))
		.update("\0")
		.update(details.diff)
		.digest("hex");
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
		const diffPayload = await getDiffPayload(pi, repo.root);
		const signature = createHash("sha256").update(diffPayload.files.join("\0")).update("\0").update(diffPayload.diff).digest("hex");
		repo.lastSignature = signature;
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

				const diffPayload = await getDiffPayload(pi, repo.root);

				const signature = createHash("sha256")
					.update(diffPayload.files.join("\0"))
					.update("\0")
					.update(diffPayload.diff)
					.digest("hex");

				if (signature === repo.lastSignature) {
					continue;
				}

				repo.lastSignature = signature;

				if (diffPayload.files.length === 0 && diffPayload.diff.length === 0) {
					continue;
				}

				if (Date.now() - repo.lastNoticeAt < 150) {
					continue;
				}
				repo.lastNoticeAt = Date.now();

				const details: ExternalChangeMessageDetails = {
					repoRoot: repo.root,
					files: diffPayload.files,
					diff: diffPayload.diff,
					truncated: diffPayload.truncated,
					source: "external",
					detectedAt: Date.now(),
				};

				pi.sendMessage(
					{
						customType: "external-git-change",
						content: details.diff,
						display: true,
						details,
					},
					{ deliverAs: "steer" },
				);
			} while (repo.queuedScan);
		} finally {
			repo.scanning = false;
		}
	};

	pi.registerMessageRenderer("external-git-change", (message, { expanded }, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const additions = (content.match(/^\+/gm) ?? []).length;
		const removals = (content.match(/^-/gm) ?? []).length;
		let text = theme.fg("toolTitle", theme.bold("external git change"));
		text += theme.fg("dim", "  ");
		text += theme.fg("success", `+${additions}`);
		text += theme.fg("dim", " / ");
		text += theme.fg("error", `-${removals}`);

		if (expanded) {
			text += `\n\n${renderDiff(content)}`;
		}

		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.on("session_start", async (_event, ctx) => {
		cleanup();

		const root = await findRepoRoot(pi, ctx.cwd);
		if (!root) {
			ctx.ui.notify("external-git-watch disabled: current directory is not a git repo", "warning");
			ctx.ui.setStatus("external-git-watch", "external-git-watch: inactive");
			return;
		}

		repo = {
			root,
			lastSignature: undefined,
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

		await refreshBaseline();
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
		void scan("startup");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("external-git-watch", "external-git-watch: inactive");
		cleanup();
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
