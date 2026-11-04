import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

interface Choice { key: string; name: string; protocol: string; status: string }

/** Select local connection keys with a terminal checkbox list, restoring terminal state on every exit. */
export async function selectImportEntries(choices: Choice[], input = process.stdin as ReadStream, output = process.stderr as WriteStream): Promise<string[]> {
  // 1. Require a real terminal; automation uses explicit --select keys instead of simulated interaction.
  if (!input.isTTY || !output.isTTY || !input.setRawMode) {
    throw new Error("Interactive import requires a terminal. Use --select KEY for automation.");
  }
  const available = choices.filter((choice) => choice.status !== "excluded");
  if (!available.length || available.length > 1000) {
    throw new Error("Interactive import requires between 1 and 1000 entries. Narrow --client or --scope.");
  }
  const selected = new Set<string>();
  let cursor = 0;
  let lines = 0;
  let finished = false;
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing;
  emitKeypressEvents(input);

  // 2. Render a bounded page and handle only navigation, selection, acceptance, and cancellation keys.
  return new Promise((resolve, reject) => {
    /** Render escaped labels without printing raw commands, URLs, environment values, or Markdown bodies. */
    function render() {
      if (lines) {
        output.write("\x1b[" + lines + "A\r\x1b[J");
      }
      const start = Math.max(0, Math.min(cursor - 5, available.length - 10));
      const visible = available.slice(start, start + 10);
      const rows = ["Select connections: arrows move, space toggles, a toggles all.", "Enter accepts; Esc/Ctrl+C cancels. No items are preselected.",
        ...visible.map((choice, index) => (start + index === cursor ? "> " : "  ") + (selected.has(choice.key) ? "[x] " : "[ ] ")
          + JSON.stringify(choice.key) + " (" + choice.protocol + ", " + choice.status + ")"),
        selected.size + " selected; " + (cursor + 1) + "/" + available.length + "."];
      const width = Math.max(30, (output.columns || 100) - 1);
      output.write(rows.map((row) => row.length > width ? row.slice(0, width - 3) + "..." : row).join("\n") + "\n");
      lines = rows.length;
    }
    /** Restore raw mode, cursor visibility, and stream ownership before resolving or rejecting the selection. */
    function finish(error?: Error) {
      if (finished) {
        return;
      }
      finished = true;
      input.off("keypress", keypress);
      input.off("error", failure);
      process.off("SIGINT", failure);
      process.off("SIGTERM", failure);
      input.setRawMode(Boolean(wasRaw));
      if (!wasFlowing) {
        input.pause();
      }
      output.write("\x1b[?25h");
      if (error) {
        reject(error);
      } else {
        resolve(available.filter((choice) => selected.has(choice.key)).map((choice) => choice.key));
      }
    }
    /** Reject terminal errors without reflecting arbitrary stream diagnostics. */
    function failure() {
      finish(new Error("Interactive selection could not read the terminal."));
    }
    /** Interpret checkbox navigation without treating typed text as executable commands. */
    function keypress(_text: string, key: { name?: string; ctrl?: boolean }) {
      if (key.name === "escape" || key.ctrl && key.name === "c") {
        finish(new Error("Import selection cancelled; no registry or profile changes."));
        return;
      }
      if (key.name === "up") {
        cursor = (cursor + available.length - 1) % available.length;
      } else if (key.name === "down") {
        cursor = (cursor + 1) % available.length;
      } else if (key.name === "space") {
        const choice = available[cursor]!;
        if (selected.has(choice.key)) {
          selected.delete(choice.key);
        } else {
          selected.add(choice.key);
        }
      } else if (key.name === "a") {
        if (selected.size === available.length) {
          selected.clear();
        } else {
          available.forEach((choice) => selected.add(choice.key));
        }
      } else if (key.name === "return") {
        if (selected.size) {
          finish();
          return;
        }
      }
      render();
    }
    input.on("keypress", keypress);
    input.on("error", failure);
    process.on("SIGINT", failure);
    process.on("SIGTERM", failure);
    input.setRawMode(true);
    input.resume();
    output.write("\x1b[?25l");
    render();
  });
}
