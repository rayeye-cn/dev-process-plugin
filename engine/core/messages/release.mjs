/**
 * release-detection texts (zh/en, same keys). See messages/index.mjs. Shown in the CI job summary; the machine-read
 * output is `release=true|false`.
 * Params: `event` CI event name, `ref` the base compared with, `versions` `[{ file, field, base, head }]`,
 * `label` the release label (may be empty), `labeled`, `release`.
 */
const value = (v, none) => (v === undefined ? none : typeof v === "string" ? v : JSON.stringify(v));
const versionList = (p, none, sep) => (p.versions ?? []).map((v) => `\`${v.file}\` ${v.field}: ${value(v.base, none)} → ${value(v.head, none)}`).join(sep);

const zh = {
  "release.summary.skip": (p) => `发版检测：${p.event ?? "?"} 事件且不是合并队列的运行 ⇒ 不跑发版门禁`,
  "release.summary": (p) =>
    `发版检测（基线 \`${p.ref}\`）：${versionList(p, "（无）", "，") || "没有配置版本号文件"}` +
    (p.label ? `；\`${p.label}\` 标签：${p.labeled ? "有" : "无"}` : "") +
    ` ⇒ ${p.release ? "跑发版门禁" : "不跑发版门禁"}`,
};

const en = {
  "release.summary.skip": (p) => `Release detection: ${p.event ?? "?"} event and not a merge-queue run ⇒ no release gate`,
  "release.summary": (p) =>
    `Release detection (base \`${p.ref}\`): ${versionList(p, "(none)", ", ") || "no version files configured"}` +
    (p.label ? `; \`${p.label}\` label: ${p.labeled ? "yes" : "no"}` : "") +
    ` ⇒ ${p.release ? "release gate runs" : "no release gate"}`,
};

export default { zh, en };
