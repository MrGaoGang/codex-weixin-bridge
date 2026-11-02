import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
test("skill search matches names and descriptions and combines with status filters", () => {
  const nodes: Record<string, any> = {};
  for (const key of ["#skillsPanel", "#refreshSkillsButton", "#skillsStatus", "#skillsErrors", "#skillsList"]) {
    nodes[key] = { setAttribute() {}, textContent: "", innerHTML: "" };
  }
  const state = { skillsLoading: false, skillsSaving: "", skillsLoaded: true, skillsError: "", skillErrors: [], skillFilter: "all", skillSearch: "  PHOTO  ", skills: [
    { name: "photo-tool", description: "Edit images", path: "/a", scope: "user", enabled: true, workspaces: [] },
    { name: "poster", description: "Create photo posters", path: "/b", scope: "user", enabled: false, workspaces: [] },
    { name: "video", description: "Render films", path: "/c", scope: "user", enabled: true, workspaces: [] }
  ] };
  const context = vm.createContext({ state, document: { querySelector: (key: string) => nodes[key], querySelectorAll: () => [] }, escapeHtml: (v: string) => v, escapeAttr: (v: string) => v });
  vm.runInContext(source.slice(source.indexOf("function renderSkills()"), source.indexOf("function showView(")), context);
  const render = () => vm.runInContext("renderSkills()", context);
  render();
  assert.match(nodes["#skillsList"].innerHTML, /photo-tool/);
  assert.match(nodes["#skillsList"].innerHTML, /poster/);
  assert.doesNotMatch(nodes["#skillsList"].innerHTML, /Render films/);
  state.skillFilter = "disabled";
  render();
  assert.match(nodes["#skillsList"].innerHTML, /poster/);
  assert.doesNotMatch(nodes["#skillsList"].innerHTML, /photo-tool/);
  state.skillSearch = "no-match";
  render();
  assert.match(nodes["#skillsList"].innerHTML, /没有匹配/);
  state.skillSearch = "";
  state.skillFilter = "all";
  render();
  assert.match(nodes["#skillsList"].innerHTML, /Render films/);
});
