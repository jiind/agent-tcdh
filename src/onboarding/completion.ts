/** Derive static shell candidates from the same usage lines shown by --help. */
export function shellCompletion(shell: string, help: string): string {
  const commands = new Map<string, Set<string>>();
  const add = (key: string, ...words: string[]) => {
    const candidates = commands.get(key) ?? new Set<string>();
    words.forEach((word) => candidates.add(word));
    commands.set(key, candidates);
  };
  const root = "__root__";
  add(root, "--help", "--version", "--json");
  const usage = help.split("Environment:")[0]!.matchAll(/^  agent-tcdh ([^\n]+)((?:\n {15,}[^\n]+)*)/gmu);
  for (const match of usage) {
    const [command, child] = match[1]!.split(" ");
    if (!command || command.startsWith("--")) {
      continue;
    }
    const flags = [...match[0].matchAll(/--[a-z][a-z-]*/gu)].map(([flag]) => flag);
    add(root, command);
    if (child && /^[a-z-]+(?:\|[a-z-]+)*$/u.test(child)) {
      for (const name of child.split("|")) {
        add(command, name);
        add(command + " " + name, "--help", ...flags, ...(command === "completion" ? [] : ["--json"]));
      }
    } else {
      add(command, "--help", "--json", ...flags);
    }
  }
  for (const [key, words] of commands) {
    if (words.has("--hub")) {
      add(key, "--config", "--hub-profile", "--hub-profiles-file", "--token-env");
    }
  }
  add("connect", "codex", "opencode", "opencode-v1", "claude-code", "gemini-cli", "cursor", "vscode");
  const rows = [...commands].map(([key, words]) => [key, [...words].sort().join(" ")] as const);
  if (shell === "bash") {
    return [
      "_agent_tcdh_complete() {",
      "  local key=__root__ candidates",
      '  if (( COMP_CWORD >= 2 )); then key="${COMP_WORDS[1]}"; fi',
      "  if (( COMP_CWORD >= 3 )); then",
      '    case "${COMP_WORDS[1]} ${COMP_WORDS[2]}" in',
      ...rows.filter(([key]) => key.includes(" ")).map(([key]) => `      '${key}') key='${key}' ;;`),
      "    esac",
      "  fi",
      '  case "$key" in',
      ...rows.map(([key, words]) => `    '${key}') candidates='${words}' ;;`),
      "  esac",
      '  COMPREPLY=($(compgen -W "$candidates" -- "${COMP_WORDS[COMP_CWORD]}"))',
      "}",
      "complete -o default -F _agent_tcdh_complete agent-tcdh",
      "",
    ].join("\n");
  }
  if (shell === "zsh") {
    return [
      "if (( ! $+functions[compdef] )); then",
      "  autoload -Uz compinit",
      "  compinit -D",
      "fi",
      "_agent_tcdh_complete() {",
      "  local key=__root__",
      "  local -a candidates",
      '  if (( CURRENT >= 3 )); then key="$words[2]"; fi',
      "  if (( CURRENT >= 4 )); then",
      '    case "$words[2] $words[3]" in',
      ...rows.filter(([key]) => key.includes(" ")).map(([key]) => `      '${key}') key='${key}' ;;`),
      "    esac",
      "  fi",
      '  case "$key" in',
      ...rows.map(([key, words]) => `    '${key}') candidates=(${words}) ;;`),
      "  esac",
      "  compadd -a candidates || _files",
      "}",
      "compdef _agent_tcdh_complete agent-tcdh",
      "",
    ].join("\n");
  }
  if (shell === "powershell") {
    return [
      "Register-ArgumentCompleter -Native -CommandName 'agent-tcdh' -ScriptBlock {",
      "  param($wordToComplete, $commandAst, $cursorPosition)",
      "  $choices = @{",
      ...rows.map(([key, words]) => `    '${key}' = '${words}'`),
      "  }",
      '  $previous = @($commandAst.CommandElements | Where-Object { $_.Extent.EndOffset -lt $cursorPosition -or $wordToComplete -eq "" })',
      "  $key = '__root__'",
      "  if ($previous.Count -ge 2) { $key = $previous[1].Extent.Text }",
      "  if ($previous.Count -ge 3) {",
      '    $subcommand = "$key $($previous[2].Extent.Text)"',
      "    if ($choices.ContainsKey($subcommand)) { $key = $subcommand }",
      "  }",
      "  if ($choices.ContainsKey($key)) {",
      "    $choices[$key].Split(' ') | Where-Object { $_.StartsWith($wordToComplete, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {",
      "      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
  }
  throw new Error("Use completion bash, zsh, or powershell.");
}
