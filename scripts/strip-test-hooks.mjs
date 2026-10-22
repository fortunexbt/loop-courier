const HOOKS = /^[ \t]*\/\/ test-hooks:start[^\n]*\n[\s\S]*?^[ \t]*\/\/ test-hooks:end[ \t]*\n/m;

/** Removes the browser-smoke test hooks (render_game_to_text, advanceTime) from a source file. */
export function stripTestHooks(source) {
  if (!HOOKS.test(source)) throw new Error("test-hooks markers not found");
  return source.replace(HOOKS, "");
}
